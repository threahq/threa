import type { Querier } from "../../db"
import { AuthorTypes, StreamTypes, type AuthorType, type StreamType } from "@threahq/types"
import { E2eStreamsRepository } from "../e2e-streams"
import type { Stream } from "../streams"

/**
 * Which sends boundary extraction LLM-clusters. The dispatch (E2E streams),
 * `BoundaryExtractionService.processMessage` (agent replies, scratchpads,
 * message-anchored threads) and the send-time attach all read this one place, so
 * a send the extractor never clusters can't be provisionally attached either
 * (INV-35).
 */

/** Agent (persona/bot) replies are assigned deterministically, never clustered. */
export function isClusteredAuthorType(authorType: AuthorType | string): boolean {
  return authorType === AuthorTypes.USER
}

/** Scratchpads and asides are one conversation by decision — no clustering. */
export function isClusteredStreamType(streamType: StreamType | string): boolean {
  return streamType !== StreamTypes.SCRATCHPAD && streamType !== StreamTypes.ASIDE
}

/**
 * A thread on a message is part of that message's conversation, so a user's
 * reply in it is placed by structure, never clustered. A card-anchored thread
 * (`event_` anchor) has no message to follow and stays clustered.
 */
export function isMessageAnchoredThread(stream: Pick<Stream, "type" | "parentAnchorId">): boolean {
  return stream.type === StreamTypes.THREAD && (stream.parentAnchorId?.startsWith("msg_") ?? false)
}

/**
 * How an undeclared send is placed in its own transaction: `thread` for a user's
 * reply in a message-anchored thread (final), `clustered` for everything the
 * extractor would LLM-cluster (a provisional guess), null for the rest, which
 * the async pass assigns. E2E streams carry ciphertext, so extraction skips them
 * at dispatch and they get no conversation at all.
 */
export async function undeclaredSendPlacement(
  db: Querier,
  params: { workspaceId: string; stream: Stream; authorType: AuthorType | string }
): Promise<"thread" | "clustered" | null> {
  const { workspaceId, stream, authorType } = params
  if (!isClusteredAuthorType(authorType)) return null
  if (!isMessageAnchoredThread(stream) && !isClusteredStreamType(stream.type)) return null
  if (await E2eStreamsRepository.isE2eStream(db, workspaceId, stream.id)) return null
  return isMessageAnchoredThread(stream) ? "thread" : "clustered"
}
