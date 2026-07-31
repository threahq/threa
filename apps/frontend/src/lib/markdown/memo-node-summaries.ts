import type { JSONContent, MemoEmbedSummary } from "@threa/types"

/**
 * Memo card content stamped onto `memoEmbed` nodes by the composer, read back
 * out of a message body.
 *
 * This is the only source for a sealed stream — the server sees a placeholder
 * body there, so it can never resolve summaries of its own — and for an
 * optimistic or offline-queued send, which renders before any round trip. The
 * server's copy supersedes it wherever both exist.
 *
 * Defensive about shape: the attr is JSON that has round-tripped through HTML
 * and through the offline queue, so a partial object is possible and must
 * degrade to "no summary" rather than to a card with holes in it.
 */
export function collectNodeMemoSummaries(content: JSONContent): MemoEmbedSummary[] {
  const summaries: MemoEmbedSummary[] = []
  const seen = new Set<string>()

  const walk = (node: JSONContent): void => {
    if (node.type === "memoEmbed") {
      const summary = node.attrs?.summary as Partial<MemoEmbedSummary> | null | undefined
      const memoId = node.attrs?.memoId
      if (
        summary &&
        typeof memoId === "string" &&
        typeof summary.title === "string" &&
        typeof summary.knowledgeType === "string" &&
        typeof summary.memoType === "string" &&
        Array.isArray(summary.tags) &&
        typeof summary.updatedAt === "string" &&
        !seen.has(memoId)
      ) {
        seen.add(memoId)
        summaries.push({
          memoId,
          title: summary.title,
          knowledgeType: summary.knowledgeType,
          memoType: summary.memoType,
          tags: summary.tags,
          updatedAt: summary.updatedAt,
        })
      }
    }
    if (node.content) {
      for (const child of node.content) walk(child)
    }
  }

  walk(content)
  return summaries
}
