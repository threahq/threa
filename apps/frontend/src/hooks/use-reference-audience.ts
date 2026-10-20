import { useMemo } from "react"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  REFERENCE_AUDIENCE_MAX_STREAM_IDS,
  type JSONContent,
  type ReferenceAudience,
  type ReferenceAudienceTarget,
  type User,
} from "@threahq/types"
import { useMessageService } from "@/contexts"
import { useActors } from "./use-actors"
import { getDmDraftUserId, isDraftId } from "./use-stream-or-draft"
import {
  collectComposerReferences,
  exposingAudiences,
  namedReaders,
  referenceKeyOf,
  referenceStreamIds,
  resolveSendWarning,
  type ComposerReference,
  type ComposerSendWarning,
} from "@/lib/reference-audience"

const EMPTY_AUDIENCES: ReferenceAudience[] = []
const NO_SENT_REFERENCES: ReadonlySet<string> = new Set()
const SETTLE_TIMEOUT_MS = 1500

/**
 * E2E streams never ask: listing their reference ids to the server would leak
 * what the sealed body points at. An unresolved stream may still turn out E2E.
 */
export function referenceAudienceTargetFor(
  streamId: string,
  stream: { e2eEnabled?: boolean } | undefined
): ReferenceAudienceTarget | null {
  const dmUserId = getDmDraftUserId(streamId)
  if (dmUserId) return { dmUserId }
  if (isDraftId(streamId) || !stream || stream.e2eEnabled) return null
  return { streamId }
}

function targetKeyOf(target: ReferenceAudienceTarget): string {
  return "streamId" in target ? `stream:${target.streamId}` : `dm:${target.dmUserId}`
}

function composeSendWarning({
  refs,
  audienceByStreamId,
  getUser,
  settled,
  targetKey,
}: {
  refs: ComposerReference[]
  audienceByStreamId: ReadonlyMap<string, ReferenceAudience>
  getUser: (id: string) => User | undefined
  settled: boolean
  targetKey: string
}): ComposerSendWarning | null {
  const warning = resolveSendWarning(refs, audienceByStreamId)
  if (!warning) return null
  const names = namedReaders(warning.lead, getUser).map(({ name }) => name)
  return { warning, names, settled, targetKey }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export interface ReferenceAudienceResult {
  sendWarning: ComposerSendWarning | null
  audienceByStreamId: Map<string, ReferenceAudience>
  /**
   * Present while the answer for exactly these refs is still in flight: resolves
   * to the settled warning, or null when the lookup fails or outlasts the wait.
   */
  awaitSendWarning: (() => Promise<ComposerSendWarning | null>) | null
  /** `referenceKeyOf` for every ref `previousContent` already sent; the alternative leaves them as they are. */
  sentReferenceKeys: ReadonlySet<string>
}

export function useReferenceAudience({
  workspaceId,
  target,
  content,
  previousContent,
}: {
  workspaceId: string
  target: ReferenceAudienceTarget | null
  content: JSONContent
  /** What an edit started from: its refs were already sent here, so they tint but never ask again. */
  previousContent?: JSONContent
}): ReferenceAudienceResult {
  const messageService = useMessageService()
  const queryClient = useQueryClient()
  const { getUser } = useActors(workspaceId)
  const targetStreamId = target && "streamId" in target ? target.streamId : null
  const refs = useMemo(() => collectComposerReferences(content, targetStreamId), [content, targetStreamId])
  const sentReferenceKeys = useMemo(
    () =>
      previousContent
        ? new Set(collectComposerReferences(previousContent, targetStreamId).map(referenceKeyOf))
        : NO_SENT_REFERENCES,
    [previousContent, targetStreamId]
  )
  const askableRefs = useMemo(
    () => refs.filter((ref) => !sentReferenceKeys.has(referenceKeyOf(ref))),
    [refs, sentReferenceKeys]
  )
  const allStreamIds = useMemo(() => referenceStreamIds(refs), [refs])
  const streamIds = useMemo(() => allStreamIds.slice(0, REFERENCE_AUDIENCE_MAX_STREAM_IDS), [allStreamIds])
  const truncated = allStreamIds.length > REFERENCE_AUDIENCE_MAX_STREAM_IDS
  const targetKey = target ? targetKeyOf(target) : ""
  const enabled = !!workspaceId && !!target && streamIds.length > 0

  const queryKey = ["referenceAudience", workspaceId, targetKey, streamIds] as const
  const queryFn = () => messageService.referenceAudience(workspaceId, { ...target!, streamIds })
  const { data, isSuccess, isPlaceholderData, isError } = useQuery({
    queryKey,
    queryFn,
    enabled,
    // A different target has different readers; only edits on the same target keep the last answer showing.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === targetKey ? keepPreviousData(previous) : undefined,
  })

  const audiences = enabled ? (data?.audiences ?? EMPTY_AUDIENCES) : EMPTY_AUDIENCES
  const audienceByStreamId = useMemo(() => exposingAudiences(audiences), [audiences])
  // Consent may only be claimed for an answer about exactly these refs: a
  // placeholder or truncated answer knows nothing about the newest share.
  const answered = isSuccess && !isPlaceholderData
  const settled = answered && !truncated
  const sendWarning = useMemo(
    () => composeSendWarning({ refs: askableRefs, audienceByStreamId, getUser, settled, targetKey }),
    [askableRefs, audienceByStreamId, getUser, settled, targetKey]
  )

  const pending = enabled && !truncated && !answered && !isError
  const awaitSendWarning = pending
    ? async () => {
        try {
          const response = await withTimeout(queryClient.fetchQuery({ queryKey, queryFn }), SETTLE_TIMEOUT_MS)
          if (!response) return null
          return composeSendWarning({
            refs: askableRefs,
            audienceByStreamId: exposingAudiences(response.audiences),
            getUser,
            settled: true,
            targetKey,
          })
        } catch {
          return null
        }
      }
    : null

  return { sendWarning, audienceByStreamId, awaitSendWarning, sentReferenceKeys }
}
