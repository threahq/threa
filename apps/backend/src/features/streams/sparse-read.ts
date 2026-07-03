import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository } from "./event-repository"
import { StreamMemberRepository } from "./member-repository"
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

async function ordinalFor(db: Querier, streamId: string, sequence: bigint): Promise<number> {
  return sequence > 0n ? StreamEventRepository.countMessagesThrough(db, streamId, sequence) : 0
}

/**
 * Apply a conversation "mark read" to one stream: lock the membership row if it
 * exists, insert the overlay rows, compact the contiguous run above the watermark
 * into the watermark (pruning absorbed rows), and emit `stream:read_messages` with
 * the absolute snapshot — all on the caller's transaction (INV-6/7). A non-member
 * thread leg (no membership row) is overlay-only: no watermark, no compaction.
 * Returns the post-write snapshot.
 */
export async function applySparseRead(db: Querier, params: ApplySparseReadParams): Promise<ReadStateSnapshot> {
  const { workspaceId, streamId, memberId } = params

  const membership = await StreamMemberRepository.findByStreamAndMemberForUpdate(db, streamId, memberId)

  await SparseReadRepository.insertReads(db, {
    workspaceId,
    streamId,
    memberId,
    messageIds: params.messageIds,
  })

  let watermarkEventId = membership?.lastReadEventId ?? null
  let watermarkSeq = await resolveWatermarkSequence(db, streamId, watermarkEventId)

  // The conversation cutoff filters by createdAt only, so member ids at/below
  // the watermark reach the insert; drop them unconditionally (not just in the
  // compaction branch) or they double-subtract in the effective unread count —
  // the overlay invariant is "every row strictly above the watermark".
  if (watermarkSeq > 0n) {
    await SparseReadRepository.pruneAtOrBelow(db, streamId, memberId, watermarkSeq)
  }

  if (membership) {
    const target = await SparseReadRepository.findCompactionTarget(db, streamId, memberId, watermarkSeq)
    if (target) {
      await StreamMemberRepository.update(db, streamId, memberId, { lastReadEventId: target.eventId })
      await SparseReadRepository.pruneAtOrBelow(db, streamId, memberId, target.sequence)
      watermarkEventId = target.eventId
      watermarkSeq = target.sequence
    }
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

/**
 * Apply a conversation "mark unread" to one stream: drop the affected messages
 * from the overlay, and — only when the watermark sits at/past the earliest
 * affected message — regress it to just before that message (existing
 * `stream:read_set` semantics, accepting collateral un-reading of interleaved
 * messages). When the watermark is already behind the affected run, or there's no
 * membership row (thread leg), the overlay delete alone suffices and the absolute
 * `stream:read_messages` snapshot is emitted. Returns the post-write snapshot.
 */
export async function applySparseUnread(db: Querier, params: ApplySparseReadParams): Promise<ReadStateSnapshot> {
  const { workspaceId, streamId, memberId, messageIds } = params

  const membership = await StreamMemberRepository.findByStreamAndMemberForUpdate(db, streamId, memberId)

  await SparseReadRepository.deleteReads(db, streamId, memberId, messageIds)

  const earliest = await StreamEventRepository.findEarliestMessageEvent(db, streamId, messageIds)
  const watermarkEventId = membership?.lastReadEventId ?? null
  const watermarkSeq = await resolveWatermarkSequence(db, streamId, watermarkEventId)

  if (membership && earliest && watermarkSeq >= earliest.sequence) {
    const previous = await StreamEventRepository.findPreviousMessageEvent(db, streamId, earliest.sequence)
    const newWatermarkEventId = previous?.id ?? null
    const newWatermarkSeq = previous?.sequence ?? 0n
    await StreamMemberRepository.update(db, streamId, memberId, { lastReadEventId: newWatermarkEventId })

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
