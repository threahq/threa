import { useMemo } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import type { JSONContent, ReferenceAudience } from "@threahq/types"
import { useMessageService } from "@/contexts"
import { useActors } from "./use-actors"
import {
  collectComposerReferences,
  exposingAudiences,
  referenceStreamIds,
  resolveSendWarning,
  type ComposerSendWarning,
  type ReferenceAudienceTarget,
} from "@/lib/reference-audience"

const MAX_STREAM_IDS = 50
const EMPTY_AUDIENCES: ReferenceAudience[] = []

function targetKeyOf(target: ReferenceAudienceTarget): string {
  return "streamId" in target ? `stream:${target.streamId}` : `dm:${target.dmUserId}`
}

export function useReferenceAudience({
  workspaceId,
  target,
  content,
}: {
  workspaceId: string
  target: ReferenceAudienceTarget | null
  content: JSONContent
}): { sendWarning: ComposerSendWarning | null; audienceByStreamId: Map<string, ReferenceAudience> } {
  const messageService = useMessageService()
  const { getUser } = useActors(workspaceId)
  const targetStreamId = target && "streamId" in target ? target.streamId : null
  const refs = useMemo(() => collectComposerReferences(content, targetStreamId), [content, targetStreamId])
  const streamIds = useMemo(() => referenceStreamIds(refs).slice(0, MAX_STREAM_IDS), [refs])
  const targetKey = target ? targetKeyOf(target) : ""

  const { data } = useQuery({
    queryKey: ["referenceAudience", workspaceId, targetKey, streamIds],
    queryFn: () => messageService.referenceAudience(workspaceId, { ...target!, streamIds }),
    enabled: !!workspaceId && !!target && streamIds.length > 0,
    staleTime: 30_000,
    retry: false,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === targetKey ? keepPreviousData(previous) : undefined,
  })

  const audiences = target && streamIds.length > 0 ? (data?.audiences ?? EMPTY_AUDIENCES) : EMPTY_AUDIENCES
  const audienceByStreamId = useMemo(() => exposingAudiences(audiences), [audiences])
  const warning = useMemo(() => resolveSendWarning(refs, audienceByStreamId), [refs, audienceByStreamId])
  const sendWarning = useMemo(() => {
    if (!warning) return null
    const names = warning.lead.sampleUserIds.flatMap((id) => {
      const name = getUser(id)?.name
      return name ? [name] : []
    })
    return { warning, names }
  }, [warning, getUser])
  return { sendWarning, audienceByStreamId }
}
