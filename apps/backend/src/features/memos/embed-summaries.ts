import { collectMemoEmbedIds } from "@threa/prosemirror"
import type { JSONContent, MemoEmbedSummary } from "@threa/types"
import type { Querier } from "../../db"
import { StreamRepository } from "../streams"
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

/**
 * Resolve summaries for memo ids grouped by the STREAM citing them, for
 * callers that span streams (the board/label batch below, the sync-log
 * sanitizer). Roots are looked up once for the distinct streams, and memos
 * once per distinct root (INV-56). Per-root grouping is not an optimisation:
 * the predicate is "readable by everyone who can see the citing stream", so a
 * memo id that qualifies under one root may not under another and must be
 * asked separately. A stream whose row is missing resolves against its own id
 * — fail closed, only the public leg of the predicate can match.
 *
 * Returns one map per input stream id (possibly empty), keyed memoId → summary.
 */
export async function resolveMemoSummariesByStream(
  db: Querier,
  workspaceId: string,
  memoIdsByStreamId: Map<string, Iterable<string>>
): Promise<Map<string, Map<string, MemoEmbedSummary>>> {
  const result = new Map<string, Map<string, MemoEmbedSummary>>()
  if (memoIdsByStreamId.size === 0) return result

  const streamIds = [...memoIdsByStreamId.keys()]
  const streams = await StreamRepository.findByIds(db, streamIds)
  const rootByStreamId = new Map(streams.map((s) => [s.id, s.rootStreamId ?? s.id]))

  const idsByRoot = new Map<string, Set<string>>()
  for (const [streamId, ids] of memoIdsByStreamId) {
    const root = rootByStreamId.get(streamId) ?? streamId
    const bucket = idsByRoot.get(root) ?? new Set<string>()
    for (const id of ids) bucket.add(id)
    idsByRoot.set(root, bucket)
  }

  const summariesByRoot = new Map<string, Map<string, MemoEmbedSummary>>()
  for (const [root, ids] of idsByRoot) {
    summariesByRoot.set(root, await MemoRepository.findEmbedSummaries(db, workspaceId, [...ids], root))
  }

  for (const streamId of streamIds) {
    const root = rootByStreamId.get(streamId) ?? streamId
    result.set(streamId, summariesByRoot.get(root) ?? new Map())
  }
  return result
}

/**
 * The same resolution for a batch of messages that may span streams — the board
 * feed and the label view, which hydrate many messages at once and whose rows
 * are not all from one root.
 */
export async function resolveMemoEmbedSummariesForMessages(
  db: Querier,
  workspaceId: string,
  messages: Array<{ id: string; streamId: string; contentJson: JSONContent }>
): Promise<Map<string, MemoEmbedSummary[]>> {
  const byMessage = new Map<string, string[]>()
  for (const message of messages) {
    const ids = collectMemoEmbedIds(message.contentJson)
    if (ids.length > 0) byMessage.set(message.id, ids)
  }
  const result = new Map<string, MemoEmbedSummary[]>()
  if (byMessage.size === 0) return result

  const memoIdsByStreamId = new Map<string, Set<string>>()
  for (const message of messages) {
    const ids = byMessage.get(message.id)
    if (!ids) continue
    const bucket = memoIdsByStreamId.get(message.streamId) ?? new Set<string>()
    for (const id of ids) bucket.add(id)
    memoIdsByStreamId.set(message.streamId, bucket)
  }
  const summariesByStream = await resolveMemoSummariesByStream(db, workspaceId, memoIdsByStreamId)

  for (const message of messages) {
    const ids = byMessage.get(message.id)
    if (!ids) continue
    const summaries = summariesByStream.get(message.streamId)
    if (!summaries) continue
    const resolved = ids.map((id) => summaries.get(id)).filter((s): s is MemoEmbedSummary => s !== undefined)
    if (resolved.length > 0) result.set(message.id, resolved)
  }
  return result
}
