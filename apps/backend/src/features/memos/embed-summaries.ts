import { collectMemoEmbedIds } from "@threa/prosemirror"
import type { JSONContent, MemoEmbedSummary } from "@threa/types"
import type { Querier } from "../../db"
import { MemoRepository } from "./repository"

/**
 * Card content for every memo a message body references, for the payload that
 * message ships on — so a memo embed card renders complete on its first frame
 * and never fetches from the stream.
 *
 * Written in the same transaction as the message (INV-4/7) by both the create
 * and the edit path: an edit that adds a reference has to carry the new memo's
 * content, and one that removes a reference has to stop carrying the old one.
 *
 * Withheld ids simply don't appear. A card with no summary renders the label
 * from the reference and stays that way — it does not fall back to a fetch,
 * which would be exactly the lazy load this design exists to remove. Sealed
 * (E2E) streams take that path for free: their stored `contentJson` is the
 * placeholder, so there are no ids to collect here.
 */
export async function resolveMemoEmbedSummaries(
  db: Querier,
  workspaceId: string,
  contentJson: JSONContent,
  citingRootStreamId: string
): Promise<MemoEmbedSummary[]> {
  const memoIds = collectMemoEmbedIds(contentJson)
  if (memoIds.length === 0) return []

  const byId = await MemoRepository.findEmbedSummaries(db, workspaceId, memoIds, citingRootStreamId)
  // Document order, so the cards below a message read in the order they are
  // cited in it.
  return memoIds.map((id) => byId.get(id)).filter((summary): summary is MemoEmbedSummary => summary !== undefined)
}
