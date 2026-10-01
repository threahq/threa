import { db, type CachedStream } from "@/db"
import type { ConversationWithStaleness, Stream } from "@threahq/types"

// Each group is a server-revisioned slice of the stream row: a snapshot older
// than the cached revision (or one without a revision once the cache has one)
// keeps the cached fields so a late fetch never rolls back a newer socket update.
const streamRevisionedGroups = [
  {
    revision: "displayNameRevision",
    fields: [
      "displayName",
      "displayNameSource",
      "displayNameRevision",
      "displayNameUpdatedByUserId",
      "sealedNameCiphertext",
      "sealedNameEnvelope",
    ],
  },
  { revision: "messageCountRevision", fields: ["messageCount", "messageCountRevision"] },
] as const

export function mergeStreamByRevision<T extends Partial<Stream>>(cached: T, incoming: Partial<Stream>): T {
  const merged = { ...cached, ...incoming }
  for (const group of streamRevisionedGroups) {
    const cachedRevision = cached[group.revision] ?? 0
    const incomingRevision = incoming[group.revision]
    const stale =
      (incomingRevision === undefined && cachedRevision > 0) ||
      (incomingRevision !== undefined && incomingRevision < cachedRevision)
    if (!stale) continue
    for (const field of group.fields) {
      ;(merged as Record<string, unknown>)[field] = cached[field]
    }
  }
  return merged as T
}

export async function persistStreamByRevision(incoming: Stream): Promise<CachedStream> {
  return db.transaction("rw", db.streams, async () => {
    const cached = await db.streams.get(incoming.id)
    const merged = cached ? mergeStreamByRevision(cached, incoming) : incoming
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
