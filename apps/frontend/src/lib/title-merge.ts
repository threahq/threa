import { db, type CachedStream } from "@/db"
import type { ConversationWithStaleness, Stream } from "@threa/types"

const streamTitleFields = [
  "displayName",
  "displayNameSource",
  "displayNameRevision",
  "displayNameUpdatedByUserId",
  "sealedNameCiphertext",
  "sealedNameEnvelope",
] as const

export function mergeStreamByTitleRevision<T extends Partial<Stream>>(cached: T, incoming: Partial<Stream>): T {
  const cachedRevision = cached.displayNameRevision ?? 0
  const incomingRevision = incoming.displayNameRevision
  const stale =
    (incomingRevision === undefined && cachedRevision > 0) ||
    (incomingRevision !== undefined && incomingRevision < cachedRevision)
  if (!stale) return { ...cached, ...incoming } as T

  const merged = { ...cached, ...incoming }
  for (const field of streamTitleFields) {
    ;(merged as Record<string, unknown>)[field] = cached[field]
  }
  return merged
}

export async function persistStreamByTitleRevision(incoming: Stream): Promise<CachedStream> {
  return db.transaction("rw", db.streams, async () => {
    const cached = await db.streams.get(incoming.id)
    const merged = cached ? mergeStreamByTitleRevision(cached, incoming) : incoming
    const row = { ...merged, _cachedAt: Date.now() } as CachedStream
    await db.streams.put(row)
    return row
  })
}

export function mergeConversationByTitleRevision<T extends ConversationWithStaleness>(cached: T, incoming: T): T {
  const cachedRevision = cached.topicSummaryRevision ?? 0
  const incomingRevision = incoming.topicSummaryRevision
  if (
    !(
      (incomingRevision === undefined && cachedRevision > 0) ||
      (incomingRevision !== undefined && incomingRevision < cachedRevision)
    )
  ) {
    return { ...cached, ...incoming }
  }
  return {
    ...cached,
    ...incoming,
    topicSummary: cached.topicSummary,
    topicSummarySource: cached.topicSummarySource,
    topicSummaryRevision: cached.topicSummaryRevision,
    topicSummaryUpdatedByUserId: cached.topicSummaryUpdatedByUserId,
  }
}
