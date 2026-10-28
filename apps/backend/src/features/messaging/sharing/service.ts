import type { Querier } from "../../../db"
import { HttpError } from "../../../lib/errors"
import { sharedMessageId } from "../../../lib/id"
import { OutboxRepository } from "../../../lib/outbox"
import { collectDocEmbedIds } from "@threahq/prosemirror"
import { type JSONContent, ShareFlavors, type ShareFlavor, ShareErrorCodes, StreamTypes } from "@threahq/types"
import { MessageRepository } from "../repository"
import type { CanReadStream, FindStreamForSharing } from "./access-check"
import {
  SharedDocRepository,
  SharedMessageRepository,
  UnsharedReferenceRepository,
  type UnsharedReference,
} from "./repository"
import { E2eStreamsRepository } from "../../e2e-streams"
import {
  StreamRepository,
  findReadersWithoutAccess,
  listAccessibleStreamIds,
  scopeReadsDocWithoutGrant,
} from "../../streams"

/**
 * A share-node extracted from a message's contentJson during scanning.
 * Cross-stream only — same-stream quoteReply nodes are the existing in-stream
 * quote behavior and are NOT shares (plan D3, service contract).
 */
interface ShareReference {
  flavor: ShareFlavor
  sourceMessageId: string
  sourceStreamId: string
}

/**
 * Walk a ProseMirror content tree and collect every sharedMessage or cross-stream
 * quoteReply node. Same-stream quoteReply is skipped — it's the existing
 * quote-reply feature, not a share — and so is a private quote, which carries
 * nothing of its source to grant.
 */
export function collectShareReferences(content: JSONContent, targetStreamId: string): ShareReference[] {
  const found: ShareReference[] = []
  walk(content)
  return found

  function walk(node: JSONContent | undefined): void {
    if (!node) return
    if (node.type === "sharedMessage") {
      const attrs = node.attrs as { messageId?: string; streamId?: string } | undefined
      if (attrs?.messageId && attrs.streamId) {
        found.push({
          flavor: ShareFlavors.POINTER,
          sourceMessageId: attrs.messageId,
          sourceStreamId: attrs.streamId,
        })
      }
    } else if (node.type === "quoteReply") {
      const attrs = node.attrs as { messageId?: string; streamId?: string; private?: boolean } | undefined
      if (attrs?.messageId && attrs.streamId && attrs.streamId !== targetStreamId && !attrs.private) {
        found.push({
          flavor: ShareFlavors.QUOTE,
          sourceMessageId: attrs.messageId,
          sourceStreamId: attrs.streamId,
        })
      }
    }
    if (node.content) {
      for (const child of node.content) {
        walk(child)
      }
    }
  }
}

export function privacyConfirmationRequired(): HttpError {
  return new HttpError("Privacy confirmation required to share this message", {
    status: 409,
    code: ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED,
  })
}

export interface ValidateAndRecordSharesParams {
  client: Querier
  workspaceId: string
  targetStreamId: string
  shareMessageId: string
  /**
   * Author of the new share-carrying message. Stored as `created_by` on each
   * `shared_messages` row — used purely for attribution / audit.
   */
  sharerId: string
  /**
   * Pre-computed access scope. When set, source-stream read-access is decided
   * by set membership against this list and `canReadStream` is **not** called.
   * Required for persona-authored messages — personas have no `stream_members`
   * rows, so a membership lookup keyed by the persona id always denies. Must
   * be the agent's `accessibleStreamIds` from `AgentAccessSpec`, not the
   * invoking user's full reach (the spec is scope-restricted by invocation
   * point, e.g. a public channel only sees public streams).
   *
   * When unset, falls back to `canReadStream(..., sharerId)` — the user-author
   * path. The two paths cannot mix: an explicit set-based override is the
   * only way to reach the agent semantics.
   */
  accessibleStreamIds?: string[]
  contentJson: JSONContent
  findStream: FindStreamForSharing
  /**
   * Source-stream read-access check for the sharer. Required to prevent a
   * user from guessing a message id in a private stream they cannot read
   * and laundering its content through a share into a stream they can.
   */
  canReadStream: CanReadStream
  /**
   * Set when the sharer has acknowledged the privacy warning. Backend re-runs
   * the check to prevent spoofed confirmations — the flag is only consulted
   * AFTER the exposure is independently established server-side.
   */
  confirmedPrivacyWarning?: boolean
  /** Scheduled fire: pre-consented share sources; an exposing share outside the set, or one the author can't read, sends unrecorded instead of 409/403. */
  consentedShareSourceIds?: ReadonlySet<string>
}

/**
 * Validates any cross-stream share-nodes in a message's contentJson and
 * writes the corresponding shared_messages rows. Invoked from inside
 * the EventService message create and edit transactions so the
 * share grant is committed atomically with the event-source + projection
 * (INV-7).
 *
 * Idempotent by design: deletes any existing rows for `shareMessageId`
 * before re-inserting, so the row set always reflects the current message
 * body. This keeps the create and edit paths on one code path — edits that
 * add, remove, or swap share nodes produce the correct final row set.
 *
 * Batched (INV-56): the source-message read and the reader-exposure count are
 * one SQL query each across every referenced message / source stream (not
 * once per ref). Per-stream callbacks (`findStream`, `canReadStream`) are
 * memoized per unique `sourceStreamId` so duplicate references targeting the
 * same source stream pay each cost once instead of once-per-ref. Calls remain
 * sequentially `await`ed on the caller's transaction client because pg
 * connections can't multiplex; the win is dedup, not concurrency.
 */
export const ShareService = {
  /**
   * Checks shares before a write that `validateAndRecordShares` can't gate: a first DM message
   * creates the DM, so a 409 must not leave behind a DM the author never sent anything to, and a
   * scheduled send is consented when it is written, not when it fires. `targetStreamId` is null
   * for a DM that doesn't exist yet. Sources in `consentedShareSourceIds` were consented to by
   * an earlier write, so an edit that keeps them doesn't ask again. Returns the consent after
   * this write: every exposing source, plus earlier consents the content still references.
   */
  async assertSharesConfirmed(params: {
    contentJson: JSONContent
    targetStreamId: string | null
    consentedShareSourceIds?: ReadonlySet<string>
    confirmedPrivacyWarning?: boolean
    listAudiences: (streamIds: string[]) => Promise<{ streamId: string; count: number }[]>
  }): Promise<string[]> {
    const targetStreamId = params.targetStreamId ?? ""
    const sources = [
      ...collectShareReferences(params.contentJson, targetStreamId).map((ref) => ({
        consentId: ref.sourceMessageId,
        exposureStreamId: ref.sourceStreamId,
      })),
      ...collectDocEmbedIds(params.contentJson).map((docId) => ({ consentId: docId, exposureStreamId: docId })),
    ]
    if (sources.length === 0) return []
    const audiences = await params.listAudiences([...new Set(sources.map((source) => source.exposureStreamId))])
    const exposingStreamIds = new Set(audiences.filter((a) => a.count > 0).map((a) => a.streamId))
    const consented = params.consentedShareSourceIds ?? new Set<string>()
    const exposed = sources
      .filter((source) => exposingStreamIds.has(source.exposureStreamId))
      .map((source) => source.consentId)
    if (!params.confirmedPrivacyWarning && exposed.some((id) => !consented.has(id))) {
      throw privacyConfirmationRequired()
    }
    const stillConsented = sources.map((source) => source.consentId).filter((id) => consented.has(id))
    return [...new Set([...exposed, ...stillConsented])]
  },

  async validateAndRecordShares(params: ValidateAndRecordSharesParams): Promise<void> {
    await recordDocShares(params)

    const references = collectShareReferences(params.contentJson, params.targetStreamId)

    // Reset the share rows for this message before recording. Covers edits
    // that removed or swapped share nodes, and is a no-op on create.
    const recordedSourceMessageIds = await SharedMessageRepository.deleteByShareMessageId(
      params.client,
      params.workspaceId,
      params.shareMessageId
    )
    await UnsharedReferenceRepository.deleteByShareMessageId(params.client, params.workspaceId, params.shareMessageId)

    if (references.length === 0) return

    // Workspace-scoped lookup (INV-8): a stranger's message id elsewhere in
    // the platform must look identical to "doesn't exist" — otherwise
    // probing distinct error codes (`MESSAGE_NOT_FOUND` vs the cross-
    // workspace and stream-mismatch paths below) leaks message-existence
    // across workspaces. `findByIds` collapses every cross-
    // workspace ref into the not-found bucket up-front.
    const uniqueSourceMessageIds = [...new Set(references.map((r) => r.sourceMessageId))]
    const uniqueSourceStreamIds = [...new Set(references.map((r) => r.sourceStreamId))]
    const sourceMessagesById = await MessageRepository.findByIds(
      params.client,
      params.workspaceId,
      uniqueSourceMessageIds
    )
    const exposedReaders = await findReadersWithoutAccess(
      params.client,
      params.workspaceId,
      { streamId: params.targetStreamId },
      uniqueSourceStreamIds
    )

    const sourceStreamCache = new Map<string, Awaited<ReturnType<FindStreamForSharing>>>()
    const canReadCache = new Map<string, boolean>()

    for (const ref of references) {
      const sourceMessage = sourceMessagesById.get(ref.sourceMessageId)
      if (!sourceMessage) {
        throw new HttpError("Source message not found", {
          status: 400,
          code: ShareErrorCodes.SOURCE_MESSAGE_NOT_FOUND,
        })
      }
      if (sourceMessage.streamId !== ref.sourceStreamId) {
        throw new HttpError("Source message does not belong to the referenced stream", {
          status: 400,
          code: ShareErrorCodes.SOURCE_STREAM_MISMATCH,
        })
      }

      let sourceStream = sourceStreamCache.get(ref.sourceStreamId)
      if (sourceStream === undefined) {
        sourceStream = await params.findStream(params.client, ref.sourceStreamId)
        sourceStreamCache.set(ref.sourceStreamId, sourceStream)
      }
      if (!sourceStream) {
        throw new HttpError("Source stream not found", {
          status: 400,
          code: ShareErrorCodes.SOURCE_STREAM_NOT_FOUND,
        })
      }
      if (sourceStream.workspaceId !== params.workspaceId) {
        throw new HttpError("Cannot share across workspaces", {
          status: 400,
          code: ShareErrorCodes.CROSS_WORKSPACE_FORBIDDEN,
        })
      }

      // E2E source streams: never let ciphertext-bearing messages cross the
      // E2E boundary via a share. The frontend renders the "Copy as
      // plaintext" alternative when it sees this code.
      if (await E2eStreamsRepository.isE2eStream(params.client, params.workspaceId, ref.sourceStreamId)) {
        throw new HttpError("Cannot share messages from end-to-end encrypted streams", {
          status: 400,
          code: ShareErrorCodes.E2E_SHARING_NOT_ALLOWED,
        })
      }

      // Authz: the sharer must themselves have read access to the source.
      // Prevents enumeration of message ids in streams the sharer can't
      // read. The target-exposure check below is orthogonal — it defends
      // target viewers; this one defends the source stream.
      //
      // For persona-authored messages, `accessibleStreamIds` is provided by
      // the agent layer (= scope-restricted `AgentAccessSpec` resolution)
      // and the check becomes pure set membership. User-authored messages
      // fall back to the membership-keyed `canReadStream` callback.
      let canRead = canReadCache.get(ref.sourceStreamId)
      if (canRead === undefined) {
        if (params.accessibleStreamIds) {
          canRead = params.accessibleStreamIds.includes(ref.sourceStreamId)
        } else {
          canRead = await params.canReadStream(params.client, params.workspaceId, ref.sourceStreamId, params.sharerId)
        }
        canReadCache.set(ref.sourceStreamId, canRead)
      }
      const outcome = shareOutcome(params, {
        consentId: ref.sourceMessageId,
        canRead,
        exposes: (exposedReaders.get(ref.sourceStreamId)?.count ?? 0) > 0,
        alreadyRecorded: recordedSourceMessageIds.has(ref.sourceMessageId),
        forbiddenMessage: "You don't have access to the source message",
      })
      if (outcome === "skip") {
        // Keep the reference so the author can share it once they can.
        await UnsharedReferenceRepository.insert(params.client, {
          workspaceId: params.workspaceId,
          shareMessageId: params.shareMessageId,
          sourceMessageId: ref.sourceMessageId,
          sourceStreamId: ref.sourceStreamId,
          flavor: ref.flavor,
          createdBy: params.sharerId,
        })
        continue
      }

      await SharedMessageRepository.insert(params.client, {
        id: sharedMessageId(),
        workspaceId: params.workspaceId,
        shareMessageId: params.shareMessageId,
        sourceMessageId: ref.sourceMessageId,
        sourceStreamId: ref.sourceStreamId,
        targetStreamId: params.targetStreamId,
        flavor: ref.flavor,
        createdBy: params.sharerId,
      })
    }
  },

  /**
   * The user's sent references that went out without a grant and still hide
   * their source from readers of the message's current stream. A reference
   * whose source has since opened up to those readers is dropped.
   */
  async listUnsharedReferences(
    db: Querier,
    workspaceId: string,
    userId: string
  ): Promise<(UnsharedReference & { streamId: string })[]> {
    const rows = await UnsharedReferenceRepository.listByCreator(db, workspaceId, userId)
    const rowsByStream = new Map<string, (UnsharedReference & { streamId: string })[]>()
    for (const row of await shareableUnsharedReferences(db, workspaceId, userId, rows)) {
      rowsByStream.set(row.streamId, [...(rowsByStream.get(row.streamId) ?? []), row])
    }
    const exposing = await Promise.all(
      [...rowsByStream].map(async ([streamId, inStream]) => {
        const readers = await findReadersWithoutAccess(db, workspaceId, { streamId }, [
          ...new Set(inStream.map((row) => row.sourceStreamId)),
        ])
        return inStream.filter((row) => (readers.get(row.sourceStreamId)?.count ?? 0) > 0)
      })
    )
    return exposing.flat()
  },

  /**
   * Records the grants a scheduled send skipped, for the references the
   * author can still share, and clears only those rows. Only those references
   * are checked: the rest of the message keeps its grants, so one reference
   * that can't be shared now doesn't block the others, and stays listed in
   * case the author regains access. Returns the source message ids it granted.
   */
  async grantUnsharedReferences(params: {
    client: Querier
    workspaceId: string
    shareMessageId: string
    userId: string
  }): Promise<string[]> {
    const rows = await UnsharedReferenceRepository.listByShareMessageId(
      params.client,
      params.workspaceId,
      params.shareMessageId
    )
    const shareable = await shareableUnsharedReferences(params.client, params.workspaceId, params.userId, rows)
    for (const ref of shareable) {
      await SharedMessageRepository.insert(params.client, {
        id: sharedMessageId(),
        workspaceId: params.workspaceId,
        shareMessageId: ref.shareMessageId,
        sourceMessageId: ref.sourceMessageId,
        sourceStreamId: ref.sourceStreamId,
        targetStreamId: ref.streamId,
        flavor: ref.flavor,
        createdBy: params.userId,
      })
    }
    const granted = shareable.map((ref) => ref.sourceMessageId)
    await UnsharedReferenceRepository.deleteBySourceMessageIds(
      params.client,
      params.workspaceId,
      params.shareMessageId,
      granted
    )
    return granted
  },
}

/**
 * Whether one share source may be granted. The sharer must read the source, and a source that
 * exposes content to the target's readers needs consent; a source this message already recorded
 * was consented to when it was added, so an edit that keeps it doesn't ask again. A scheduled
 * fire has no author to ask and can't grant what the author lost access to, so it skips where a
 * live send throws 403 or 409.
 */
function shareOutcome(
  params: ValidateAndRecordSharesParams,
  source: { consentId: string; canRead: boolean; exposes: boolean; alreadyRecorded: boolean; forbiddenMessage: string }
): "grant" | "skip" {
  const consented =
    params.confirmedPrivacyWarning || source.alreadyRecorded || params.consentedShareSourceIds?.has(source.consentId)
  if (source.canRead && (!source.exposes || consented)) return "grant"
  if (params.consentedShareSourceIds) return "skip"
  if (!source.canRead) {
    throw new HttpError(source.forbiddenMessage, { status: 403, code: ShareErrorCodes.SOURCE_FORBIDDEN })
  }
  throw privacyConfirmationRequired()
}

/**
 * Records the read grants a message's doc chips carry, under the same `shareOutcome` rule as
 * message shares. A sharer, user or agent, shares only docs it reads without a grant, so a grant never re-shares.
 */
async function recordDocShares(params: ValidateAndRecordSharesParams): Promise<void> {
  const previouslyGranted = await SharedDocRepository.deleteByShareMessageId(
    params.client,
    params.workspaceId,
    params.shareMessageId
  )
  const granted = await grantDocShares(params, previouslyGranted)
  const revoked = [...previouslyGranted].filter((docId) => !granted.includes(docId))
  if (revoked.length > 0) {
    await OutboxRepository.insert(params.client, "access:narrowed", {
      workspaceId: params.workspaceId,
      docIds: revoked,
    })
  }
}

async function grantDocShares(
  params: ValidateAndRecordSharesParams,
  previouslyGranted: Set<string>
): Promise<string[]> {
  const chipDocIds = collectDocEmbedIds(params.contentJson)
  if (chipDocIds.length === 0) return []

  const docs = await StreamRepository.findByIds(params.client, params.workspaceId, chipDocIds)
  const docIdsFound = new Set(docs.filter((doc) => doc.type === StreamTypes.DOC).map((doc) => doc.id))
  // A scheduled fire sends what the author wrote even when a doc has since gone; it just grants nothing for it.
  if (!params.consentedShareSourceIds && chipDocIds.some((docId) => !docIdsFound.has(docId))) {
    throw new HttpError("Doc not found", { status: 400, code: ShareErrorCodes.SOURCE_STREAM_NOT_FOUND })
  }
  const docIds = chipDocIds.filter((docId) => docIdsFound.has(docId))
  if (docIds.length === 0) return []
  const scope = params.accessibleStreamIds ? new Set(params.accessibleStreamIds) : null
  const readable = scope
    ? new Set(docs.filter((doc) => scopeReadsDocWithoutGrant(scope, doc)).map((doc) => doc.id))
    : await listAccessibleStreamIds(params.client, params.workspaceId, params.sharerId, docIds, { docGrants: false })

  const exposedReaders = await findReadersWithoutAccess(
    params.client,
    params.workspaceId,
    { streamId: params.targetStreamId },
    docIds
  )

  const granted: string[] = []
  for (const docId of docIds) {
    const outcome = shareOutcome(params, {
      consentId: docId,
      canRead: readable.has(docId),
      exposes: (exposedReaders.get(docId)?.count ?? 0) > 0,
      alreadyRecorded: previouslyGranted.has(docId),
      forbiddenMessage: "You don't have access to the doc",
    })
    if (outcome === "grant") granted.push(docId)
  }

  await SharedDocRepository.insertMany(params.client, {
    workspaceId: params.workspaceId,
    shareMessageId: params.shareMessageId,
    createdBy: params.sharerId,
    docIds: granted,
  })
  return granted
}

/**
 * The references sharing could still fix, with the carrying message's current
 * stream: both messages exist undeleted, the source still sits in the stream
 * its pointer names (validation rejects a moved one), and the user still reads
 * both the source and the destination.
 */
async function shareableUnsharedReferences(
  db: Querier,
  workspaceId: string,
  userId: string,
  rows: UnsharedReference[]
): Promise<(UnsharedReference & { streamId: string })[]> {
  if (rows.length === 0) return []
  const messages = await MessageRepository.findByIds(db, workspaceId, [
    ...new Set(rows.flatMap((row) => [row.shareMessageId, row.sourceMessageId])),
  ])
  const streamIds = new Set(rows.map((row) => row.sourceStreamId))
  for (const message of messages.values()) streamIds.add(message.streamId)
  const readable = await listAccessibleStreamIds(db, workspaceId, userId, [...streamIds])
  return rows.flatMap((row) => {
    const message = messages.get(row.shareMessageId)
    const source = messages.get(row.sourceMessageId)
    if (!message || message.deletedAt || !source || source.deletedAt) return []
    if (source.streamId !== row.sourceStreamId) return []
    if (!readable.has(row.sourceStreamId) || !readable.has(message.streamId)) return []
    return [{ ...row, streamId: message.streamId }]
  })
}
