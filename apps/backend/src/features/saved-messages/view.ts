import type { SavedMessageView, SavedMessageSnapshot } from "@threa/types"
import { Visibilities } from "@threa/types"
import { type Querier } from "../../db"
// Streams must import before messaging — see service.ts for why.
import { StreamRepository, StreamMemberRepository, type Stream } from "../streams"
import { MessageRepository, type Message } from "../messaging"
import type { SavedMessage } from "./repository"

/**
 * Resolve a batch of saved rows into the wire shape the frontend consumes.
 *
 * Live message fetch (never denormalize content into saved_messages — INV-58
 * keeps contentJson canonical on the message itself). If a message is soft-
 * deleted or the owner has lost stream access, the snapshot is omitted and
 * `unavailableReason` is set so the UI can render a "deleted" or "access lost"
 * pill without duplicating content.
 *
 * Accepts a `Querier` so callers inside an enclosing `withTransaction` can
 * pass the tx client — the outbox payload must see the same committed
 * snapshot as the row writes (INV-4/7). Pool also satisfies Querier for the
 * standalone read path.
 */
export async function resolveSavedView(db: Querier, userId: string, rows: SavedMessage[]): Promise<SavedMessageView[]> {
  if (rows.length === 0) return []

  // Standalone (message-less) rows need no message fetch or access check —
  // they're owned by the user outright.
  const messageIds = Array.from(new Set(rows.flatMap((r) => (r.messageId ? [r.messageId] : []))))
  const streamIds = Array.from(new Set(rows.flatMap((r) => (r.streamId ? [r.streamId] : []))))

  // Batch fetch messages and streams (INV-56). Access resolution uses root
  // streams for threads; fetch those in a second pass.
  const [messages, streams] = await Promise.all([
    MessageRepository.findByIds(db, messageIds),
    StreamRepository.findByIds(db, streamIds),
  ])

  const streamById = new Map<string, Stream>()
  for (const s of streams) streamById.set(s.id, s)

  const rootIds = new Set<string>()
  for (const s of streams) {
    if (s.rootStreamId && !streamById.has(s.rootStreamId)) rootIds.add(s.rootStreamId)
  }
  if (rootIds.size > 0) {
    const rootStreams = await StreamRepository.findByIds(db, Array.from(rootIds))
    for (const s of rootStreams) streamById.set(s.id, s)
  }

  const accessibleStreamIds = await computeAccessibleStreams(db, userId, streams, streamById)

  return rows.map((row) =>
    toView(
      row,
      row.messageId ? (messages.get(row.messageId) ?? null) : null,
      row.streamId ? (streamById.get(row.streamId) ?? null) : null,
      row.streamId !== null && accessibleStreamIds.has(row.streamId)
    )
  )
}

/**
 * Access rule: thread -> root stream visibility/membership; else self. Public
 * streams grant access to all workspace users; private streams require
 * explicit membership.
 */
async function computeAccessibleStreams(
  db: Querier,
  userId: string,
  streams: Stream[],
  streamById: Map<string, Stream>
): Promise<Set<string>> {
  if (streams.length === 0) return new Set()

  const accessible = new Set<string>()
  const privateAccessStreamIds = new Set<string>()
  // Map access-stream -> original streams it authorizes
  const authorizes = new Map<string, string[]>()

  for (const s of streams) {
    const accessStreamId = s.rootStreamId ?? s.id
    const accessStream = streamById.get(accessStreamId)
    if (!accessStream) continue

    if (accessStream.visibility === Visibilities.PUBLIC) {
      accessible.add(s.id)
      continue
    }

    privateAccessStreamIds.add(accessStreamId)
    const list = authorizes.get(accessStreamId) ?? []
    list.push(s.id)
    authorizes.set(accessStreamId, list)
  }

  for (const accessStreamId of privateAccessStreamIds) {
    const members = await StreamMemberRepository.filterMemberIds(db, accessStreamId, [userId])
    if (members.has(userId)) {
      for (const sid of authorizes.get(accessStreamId) ?? []) accessible.add(sid)
    }
  }

  return accessible
}

function toView(
  row: SavedMessage,
  message: Message | null,
  stream: Stream | null,
  hasAccess: boolean
): SavedMessageView {
  let snapshot: SavedMessageSnapshot | null = null
  let unavailableReason: SavedMessageView["unavailableReason"] = null

  if (row.messageId === null) {
    // Standalone to-do: no snapshot and nothing unavailable.
  } else if (!message || message.deletedAt !== null) {
    unavailableReason = "deleted"
  } else if (!hasAccess) {
    unavailableReason = "access_lost"
  } else {
    snapshot = {
      authorId: message.authorId,
      authorType: message.authorType,
      contentJson: message.contentJson,
      contentMarkdown: message.contentMarkdown,
      createdAt: message.createdAt.toISOString(),
      editedAt: message.editedAt?.toISOString() ?? null,
      streamName: stream?.displayName ?? null,
    }
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    messageId: row.messageId,
    streamId: row.streamId,
    status: row.status,
    title: row.title,
    note: row.note,
    remindAt: row.remindAt?.toISOString() ?? null,
    reminderSentAt: row.reminderSentAt?.toISOString() ?? null,
    savedAt: row.savedAt.toISOString(),
    statusChangedAt: row.statusChangedAt.toISOString(),
    message: snapshot,
    unavailableReason,
  }
}
