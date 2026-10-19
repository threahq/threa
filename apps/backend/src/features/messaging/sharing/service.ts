import type { Querier } from "../../../db"
import { HttpError } from "../../../lib/errors"
import { sharedMessageId } from "../../../lib/id"
import { type JSONContent, ShareFlavors, type ShareFlavor, ShareErrorCodes } from "@threahq/types"
import { MessageRepository } from "../repository"
import type { CanReadStream, FindStreamForSharing } from "./access-check"
import { SharedMessageRepository } from "./repository"
import { E2eStreamsRepository } from "../../e2e-streams"
import { findReadersWithoutAccess } from "../../streams"

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
 * quote-reply feature, not a share.
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
      const attrs = node.attrs as { messageId?: string; streamId?: string } | undefined
      if (attrs?.messageId && attrs.streamId && attrs.streamId !== targetStreamId) {
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
  async validateAndRecordShares(params: ValidateAndRecordSharesParams): Promise<void> {
    const references = collectShareReferences(params.contentJson, params.targetStreamId)

    // Reset the share rows for this message before recording. Covers edits
    // that removed or swapped share nodes, and is a no-op on create.
    const recordedSourceMessageIds = await SharedMessageRepository.deleteByShareMessageId(
      params.client,
      params.workspaceId,
      params.shareMessageId
    )

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
      if (!canRead) {
        throw new HttpError("You don't have access to the source message", {
          status: 403,
          code: ShareErrorCodes.SOURCE_FORBIDDEN,
        })
      }

      // `confirmedPrivacyWarning` is a single boolean covering every reference
      // in the message, so one confirmation consents for all of them. A
      // reference this message already recorded was accepted when it was
      // added, so an edit that keeps it doesn't ask again.
      if (
        (exposedReaders.get(ref.sourceStreamId)?.count ?? 0) > 0 &&
        !params.confirmedPrivacyWarning &&
        !recordedSourceMessageIds.has(ref.sourceMessageId)
      ) {
        throw privacyConfirmationRequired()
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
}
