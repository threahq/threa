import type { Querier } from "../../../db"
import { HttpError } from "../../../lib/errors"
import { sharedMessageId } from "../../../lib/id"
import { type JSONContent, ShareFlavors, type ShareFlavor, ShareErrorCodes } from "@threa/types"
import { MessageRepository } from "../repository"
import {
  crossesPrivacyBoundary,
  type CanReadStream,
  type CountExposedMembers,
  type FindStreamForSharing,
  type IsAncestorStream,
  type ResolveEffectiveStream,
} from "./access-check"
import { SharedMessageRepository } from "./repository"
import { E2eStreamsRepository } from "../../e2e-streams"

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
  /**
   * Stream loader injected by the caller. Avoids importing StreamRepository
   * directly from inside this sub-feature which would create a barrel cycle
   * between messaging and streams.
   */
  findStream: FindStreamForSharing
  /**
   * Resolves a source stream to its effective access stream (root for
   * threads). Wraps the canonical helper in `streams/access.ts` so the
   * thread→root rule lives in one place. See `ResolveEffectiveStream`.
   */
  resolveEffectiveStream: ResolveEffectiveStream
  /**
   * Ancestor check injected by the caller (same barrel-cycle reason as
   * {@link findStream}). Expected to resolve the chain in the DB layer via
   * a recursive CTE — the sharing service must not walk it app-side.
   */
  isAncestor: IsAncestorStream
  /**
   * Exposed-member count injected by the caller (same barrel-cycle reason).
   * Runs the set-based NOT-EXISTS count in the repository so this service
   * never issues its own SQL (INV-5).
   */
  countExposedMembers: CountExposedMembers
  /**
   * Source-stream read-access check for the sharer. Required to prevent a
   * user from guessing a message id in a private stream they cannot read
   * and laundering its content through a share into a stream they can.
   */
  canReadStream: CanReadStream
  /**
   * Set when the sharer has acknowledged the privacy warning in the modal.
   * Backend re-runs the check to prevent spoofed confirmations — the flag is
   * only consulted AFTER the cross-boundary condition is independently
   * established server-side.
   */
  confirmedPrivacyWarning?: boolean
}

/**
 * Validates any cross-stream share-nodes in a message's contentJson and
 * writes the corresponding shared_messages rows. Invoked from inside
 * MessageEventService.createMessage and editMessage transactions so the
 * share grant is committed atomically with the event-source + projection
 * (INV-7).
 *
 * Idempotent by design: deletes any existing rows for `shareMessageId`
 * before re-inserting, so the row set always reflects the current message
 * body. This keeps the create and edit paths on one code path — edits that
 * add, remove, or swap share nodes produce the correct final row set.
 *
 * Batched (INV-56): the source-message read is one SQL query for every
 * referenced id (not findById-per-ref). Per-stream callbacks
 * (`findStream`, `canReadStream`, `crossesPrivacyBoundary`) are memoized
 * per unique `sourceStreamId` so duplicate references targeting the same
 * source stream pay each cost once instead of once-per-ref. Calls remain
 * sequentially `await`ed on the caller's transaction client because pg
 * connections can't multiplex; the win is dedup, not concurrency. Slice 1
 * messages carry one share node so the win is structural — Slice 2's
 * multi-node composer benefits without further changes.
 */
export const ShareService = {
  async validateAndRecordShares(params: ValidateAndRecordSharesParams): Promise<void> {
    const references = collectShareReferences(params.contentJson, params.targetStreamId)

    // Reset the share rows for this message before recording. Covers edits
    // that removed or swapped share nodes, and is a no-op on create.
    await SharedMessageRepository.deleteByShareMessageId(params.client, params.workspaceId, params.shareMessageId)

    if (references.length === 0) return

    // INV-56 — batch the source-message read into one SQL query rather than
    // one findById per reference, and memoize per-source-stream callbacks so
    // duplicate references that target the same source stream don't repeat
    // the findStream / canReadStream / crossesPrivacyBoundary work. Calls
    // remain sequential because they share the caller's transaction client
    // (pg connections can't multiplex), but each unique stream pays the
    // cost once instead of once-per-reference.
    //
    // Workspace-scoped lookup (INV-8): a stranger's message id elsewhere in
    // the platform must look identical to "doesn't exist" — otherwise
    // probing distinct error codes (`MESSAGE_NOT_FOUND` vs the cross-
    // workspace and stream-mismatch paths below) leaks message-existence
    // across workspaces. `findByIdsInWorkspace` collapses every cross-
    // workspace ref into the not-found bucket up-front.
    const uniqueSourceMessageIds = [...new Set(references.map((r) => r.sourceMessageId))]
    const sourceMessagesById = await MessageRepository.findByIdsInWorkspace(
      params.client,
      params.workspaceId,
      uniqueSourceMessageIds
    )

    const sourceStreamCache = new Map<string, Awaited<ReturnType<FindStreamForSharing>>>()
    const canReadCache = new Map<string, boolean>()
    const boundaryCache = new Map<string, Awaited<ReturnType<typeof crossesPrivacyBoundary>>>()

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

      let boundary = boundaryCache.get(ref.sourceStreamId)
      if (boundary === undefined) {
        boundary = await crossesPrivacyBoundary(
          params.client,
          params.findStream,
          params.resolveEffectiveStream,
          params.isAncestor,
          params.countExposedMembers,
          ref.sourceStreamId,
          params.targetStreamId
        )
        boundaryCache.set(ref.sourceStreamId, boundary)
      }
      // SLICE-1 ASSUMPTION: `confirmedPrivacyWarning` is a single boolean
      // covering every reference in the message. That's safe today because
      // (a) share-to-parent short-circuits via the ancestor check so
      // `triggered` is always false, and (b) Slice 2's modal pre-fills
      // exactly one share node. When arbitrary multi-reference composing
      // lands, swap to per-source confirmation (e.g. a
      // `confirmedPrivacyFor: Set<sourceStreamId>`) so a user can't see
      // the warning for one private source and have it transitively
      // confirm a different private source they never saw.
      if (boundary.triggered && !params.confirmedPrivacyWarning) {
        throw new HttpError("Privacy confirmation required to share this message", {
          status: 409,
          code: ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED,
        })
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
