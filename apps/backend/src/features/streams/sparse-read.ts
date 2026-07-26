import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository } from "./event-repository"
import { ReadStateRepository } from "./read-state-repository"
import { SparseReadRepository } from "./sparse-read-repository"

/**
 * The absolute post-write read-state for one stream — the shape both the socket
 * snapshot (`stream:read_messages`) and the conversation read/unread HTTP
 * responses carry. `readMessageIds` is the ENTIRE sparse overlay after the write.
 */
export interface ReadStateSnapshot {
  streamId: string
  readMessageIds: string[]
  lastReadEventId: string | null
  lastReadSequence: string
  lastReadOrdinal: number
  /**
   * The message ids this write marked read (pre-compaction, this stream's
   * slice) — set on the read path only. Drives the client's message-granular
   * activity drop; absent on unread/regress snapshots.
   */
  markedMessageIds?: string[]
}

export interface ApplySparseReadParams {
  workspaceId: string
  streamId: string
  memberId: string
  /** Message ids to add to the overlay (already scoped to this stream). */
  messageIds: string[]
}

async function resolveWatermarkSequence(db: Querier, streamId: string, eventId: string | null): Promise<bigint> {
  if (!eventId) return 0n
  const pos = await StreamEventRepository.getMessageOrdinalForEvent(db, streamId, eventId)
  return pos ? pos.sequence : 0n
}

/**
 * The viewer's watermark seed: the standalone `stream_read_state` row, ensured +
 * locked FOR UPDATE so concurrent conversation reads on the same (stream, user)
 * serialize behind one row (INV-20) for members and non-members alike. A seeded
 * row carries a NULL watermark (never read = position before the first message);
 * a present NULL is an explicit unread-to-zero. Read state is not a membership
 * surface — this never creates a membership row (INV-62).
 */
async function watermarkSeed(db: Querier, streamId: string, userId: string): Promise<string | null> {
  const readState = await ReadStateRepository.ensureForUpdate(db, streamId, userId)
  return readState ? readState.lastReadEventId : null
}

async function ordinalFor(db: Querier, streamId: string, sequence: bigint): Promise<number> {
  return sequence > 0n ? StreamEventRepository.countMessagesThrough(db, streamId, sequence) : 0
}

/**
 * Apply a conversation "mark read" to one stream: insert the overlay rows, then
 * lock the standalone read-state row (ensured FOR UPDATE) and compact the contiguous run
 * above the watermark into the watermark (pruning absorbed rows), and emit
 * `stream:read_messages` with the absolute snapshot — all on the caller's
 * transaction (INV-6/7). The compaction advance is monotonic in the standalone
 * store for every viewer (member or not); membership is never touched on a read
 * (membership ≠ access ≠ read state, INV-62).
 * Returns the post-write snapshot.
 */
export async function applySparseRead(db: Querier, params: ApplySparseReadParams): Promise<ReadStateSnapshot> {
  const { workspaceId, streamId, memberId } = params

  await SparseReadRepository.insertReads(db, {
    workspaceId,
    streamId,
    memberId,
    messageIds: params.messageIds,
  })

  let watermarkEventId = await watermarkSeed(db, streamId, memberId)
  let watermarkSeq = await resolveWatermarkSequence(db, streamId, watermarkEventId)

  // The conversation cutoff filters by createdAt only, so member ids at/below
  // the watermark reach the insert; drop them unconditionally (not just in the
  // compaction branch) or they double-subtract in the effective unread count —
  // the overlay invariant is "every row strictly above the watermark".
  if (watermarkSeq > 0n) {
    await SparseReadRepository.pruneAtOrBelow(db, streamId, memberId, watermarkSeq)
  }

  const seedEventId = watermarkEventId
  const target = await SparseReadRepository.findCompactionTarget(db, streamId, memberId, watermarkSeq)
  if (target) {
    watermarkEventId = target.eventId
    watermarkSeq = target.sequence
  }
  // The tide also rises over sunken rocks: a trailing run of DELETED messages
  // just above the (possibly compacted) watermark can never be read by anyone,
  // so absorb it too — otherwise agent-deleted transients above the watermark
  // stall it forever and the stream can never fully read from the board.
  const deletedRun = await SparseReadRepository.findTrailingDeletedRunEnd(db, streamId, watermarkSeq)
  if (deletedRun) {
    watermarkEventId = deletedRun.eventId
    watermarkSeq = deletedRun.sequence
  }
  if (watermarkEventId !== seedEventId) {
    // Compaction moved the frontier above the seed: land it in the standalone
    // store (locked by the seed above). A compaction target is always a real
    // event, so the watermark is non-null here.
    if (watermarkEventId) {
      await ReadStateRepository.advance(db, streamId, memberId, watermarkEventId)
    }
    await SparseReadRepository.pruneAtOrBelow(db, streamId, memberId, watermarkSeq)
  }

  const lastReadOrdinal = await ordinalFor(db, streamId, watermarkSeq)
  const overlay = await SparseReadRepository.listOverlayIds(db, streamId, memberId)

  const snapshot: ReadStateSnapshot = {
    streamId,
    readMessageIds: overlay,
    lastReadEventId: watermarkEventId,
    lastReadSequence: watermarkSeq.toString(),
    lastReadOrdinal,
    markedMessageIds: params.messageIds,
  }

  await OutboxRepository.insert(db, "stream:read_messages", {
    workspaceId,
    authorId: memberId,
    streamId,
    readMessageIds: overlay,
    lastReadEventId: watermarkEventId,
    lastReadSequence: watermarkSeq.toString(),
    lastReadOrdinal,
    markedMessageIds: params.messageIds,
  })

  return snapshot
}

/**
 * Apply a conversation "mark unread" to one stream: drop the affected messages
 * from the overlay, and — only when the watermark sits at/past the earliest
 * affected message — regress it to just before that message (existing
 * `stream:read_set` semantics, accepting collateral un-reading of interleaved
 * messages). The regress writes the standalone store for every viewer (one of
 * the sanctioned downward moves); membership is never touched. When the watermark
 * is already behind the affected run, the overlay delete alone suffices and the
 * absolute `stream:read_messages` snapshot is emitted. Returns the post-write
 * snapshot.
 */
export async function applySparseUnread(db: Querier, params: ApplySparseReadParams): Promise<ReadStateSnapshot> {
  const { workspaceId, streamId, memberId, messageIds } = params

  await SparseReadRepository.deleteReads(db, streamId, memberId, messageIds)

  const earliest = await StreamEventRepository.findEarliestMessageEvent(db, streamId, messageIds)
  const watermarkEventId = await watermarkSeed(db, streamId, memberId)
  const watermarkSeq = await resolveWatermarkSequence(db, streamId, watermarkEventId)

  if (earliest && watermarkSeq >= earliest.sequence) {
    const previous = await StreamEventRepository.findPreviousMessageEvent(db, streamId, earliest.sequence)
    const newWatermarkEventId = previous?.id ?? null
    const newWatermarkSeq = previous?.sequence ?? 0n
    // The regress lands in stream_read_state unconditionally (may be null — same tx).
    await ReadStateRepository.set(db, streamId, memberId, newWatermarkEventId)

    const lastReadOrdinal = await ordinalFor(db, streamId, newWatermarkSeq)
    const overlay = await SparseReadRepository.listOverlayIds(db, streamId, memberId)

    const snapshot: ReadStateSnapshot = {
      streamId,
      readMessageIds: overlay,
      lastReadEventId: newWatermarkEventId,
      lastReadSequence: newWatermarkSeq.toString(),
      lastReadOrdinal,
    }

    await OutboxRepository.insert(db, "stream:read_set", {
      workspaceId,
      authorId: memberId,
      streamId,
      lastReadEventId: newWatermarkEventId,
      lastReadSequence: newWatermarkSeq.toString(),
      lastReadOrdinal,
      readMessageIds: overlay,
    })

    return snapshot
  }

  const lastReadOrdinal = await ordinalFor(db, streamId, watermarkSeq)
  const overlay = await SparseReadRepository.listOverlayIds(db, streamId, memberId)

  const snapshot: ReadStateSnapshot = {
    streamId,
    readMessageIds: overlay,
    lastReadEventId: watermarkEventId,
    lastReadSequence: watermarkSeq.toString(),
    lastReadOrdinal,
  }

  await OutboxRepository.insert(db, "stream:read_messages", {
    workspaceId,
    authorId: memberId,
    streamId,
    readMessageIds: overlay,
    lastReadEventId: watermarkEventId,
    lastReadSequence: watermarkSeq.toString(),
    lastReadOrdinal,
  })

  return snapshot
}
