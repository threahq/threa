import type { Querier } from "@threa/backend-common"
import { StreamTypes, type Visibility } from "@threa/types"
import { StreamRepository, type Stream } from "../streams"
import { MessageRepository } from "../messaging"

/**
 * Resolve the routing dimensions a `conversation:created`/`updated` event needs:
 * the parent channel's stream id (for thread discoverability) and the
 * **access-root** stream's visibility (INV-62) — the parent channel for a thread,
 * the stream itself otherwise. Visibility gates workspace-wide board delivery in
 * `delivery-groups.ts`: a public root reaches the whole workspace, anything else
 * stays scoped to the stream's members.
 *
 * The single home for the thread→root rule, shared by the synchronous assigner,
 * the async boundary extractor, and the reassign path so the three can't drift.
 */
export async function resolveConversationDelivery(
  client: Querier,
  stream: Stream | null
): Promise<{ parentStreamId: string | undefined; streamVisibility: Visibility | undefined }> {
  if (stream?.type === StreamTypes.THREAD && stream.parentAnchorId?.startsWith("msg_")) {
    const parentMessage = await MessageRepository.findById(client, stream.parentAnchorId)
    const parentStreamId = parentMessage?.streamId
    const parentStream = parentMessage ? await StreamRepository.findById(client, parentMessage.streamId) : null
    return { parentStreamId, streamVisibility: parentStream?.visibility }
  }
  return { parentStreamId: undefined, streamVisibility: stream?.visibility }
}
