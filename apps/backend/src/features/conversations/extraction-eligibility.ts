import type { Querier } from "../../db"
import { AuthorTypes, StreamTypes, type AuthorType, type StreamType } from "@threa/types"
import { E2eStreamsRepository } from "../e2e-streams"

/**
 * Which sends boundary extraction LLM-clusters. The dispatch (E2E streams),
 * `BoundaryExtractionService.processMessage` (agent replies, scratchpads) and
 * the send-time provisional attach all read this one place, so a stream or
 * author the extractor never clusters can't be provisionally attached either
 * (INV-35).
 */

/** Agent (persona/bot) replies are assigned deterministically, never clustered. */
export function isClusteredAuthorType(authorType: AuthorType | string): boolean {
  return authorType === AuthorTypes.USER
}

/** A scratchpad is one conversation by decision — no clustering. */
export function isClusteredStreamType(streamType: StreamType | string): boolean {
  return streamType !== StreamTypes.SCRATCHPAD
}

/**
 * The full send-time gate: everything the extractor would LLM-cluster, and
 * nothing it wouldn't. E2E streams carry ciphertext, so extraction skips them
 * at dispatch.
 */
export async function isClusteredSend(
  db: Querier,
  params: { workspaceId: string; streamId: string; streamType: StreamType | string; authorType: AuthorType | string }
): Promise<boolean> {
  if (!isClusteredAuthorType(params.authorType) || !isClusteredStreamType(params.streamType)) return false
  return !(await E2eStreamsRepository.isE2eStream(db, params.workspaceId, params.streamId))
}
