import { z } from "zod"
import type { Pool } from "pg"
import {
  STREAM_PREVIEW_HISTORY_MAX_STREAMS,
  type JSONContent,
  type SlotMap,
  type SharedMessageRef,
  type StreamPreviewHistoryBatchResponse,
} from "@threahq/types"
import { collectSharedMessageRefs, toDualSlotMaps, type EventService, type HydratedSharedMessage } from "../messaging"
import type { LinkPreviewService } from "../link-previews"
import { listAccessibleStreamIds } from "./access"
import { StreamRepository } from "./repository"
import { StreamEventRepository, type StreamEvent } from "./event-repository"
import { collectThreadAnchorIds, enrichEventsWithLinkPreviews, hydrateSlotsForEvents } from "./bootstrap-enrichment"

export const previewHistorySchema = z
  .object({
    streamIds: z
      .array(z.string().regex(/^stream_[A-Za-z0-9]+$/))
      .min(1)
      .max(STREAM_PREVIEW_HISTORY_MAX_STREAMS)
      .refine((ids) => new Set(ids).size === ids.length, "streamIds must be unique"),
  })
  .strict()

interface Dependencies {
  pool: Pool
  eventService: EventService
  linkPreviewService: LinkPreviewService
}

function toWireSlots(slots: Record<string, HydratedSharedMessage>): SlotMap {
  return Object.fromEntries(
    Object.entries(slots).map(([key, slot]) => {
      if (slot.state === "ok") {
        return [
          key,
          { ...slot, editedAt: slot.editedAt?.toISOString() ?? null, createdAt: slot.createdAt.toISOString() },
        ]
      }
      if (slot.state === "deleted") return [key, { ...slot, deletedAt: slot.deletedAt.toISOString() }]
      return [key, slot]
    })
  )
}

export class StreamPreviewHistoryService {
  constructor(private readonly deps: Dependencies) {}

  async get(workspaceId: string, userId: string, streamIds: string[]): Promise<StreamPreviewHistoryBatchResponse> {
    const snapshotAt = new Date().toISOString()
    const { pool, eventService, linkPreviewService } = this.deps
    const accessible = await listAccessibleStreamIds(pool, workspaceId, userId, streamIds)
    const streams = await StreamRepository.findByIdsInWorkspace(pool, workspaceId, streamIds)
    const streamsById = new Map(streams.map((stream) => [stream.id, stream]))
    const authorizedIds = streamIds.filter((id) => accessible.has(id))
    const windows = await StreamEventRepository.listPreviewWindows(pool, authorizedIds, userId)
    const events = [...windows.values()].flatMap((window) => window.events)
    const anchors = collectThreadAnchorIds(events)
    const [threadData, threadSummaries] = await Promise.all([
      StreamRepository.findThreadsWithReplyCounts(pool, authorizedIds, anchors),
      StreamRepository.findThreadSummaries(pool, authorizedIds, anchors),
    ])
    const enriched = await eventService.enrichBootstrapEvents(events, threadData, threadSummaries, {
      workspaceId,
      streamIds: authorizedIds,
    })
    const withPreviews = await enrichEventsWithLinkPreviews(linkPreviewService, workspaceId, userId, enriched)
    const hydrated = await hydrateSlotsForEvents(pool, workspaceId, userId, withPreviews)
    const eventsByStream = new Map<string, StreamEvent[]>()
    for (const event of withPreviews) {
      const group = eventsByStream.get(event.streamId) ?? []
      group.push(event)
      eventsByStream.set(event.streamId, group)
    }

    return {
      results: streamIds.map((streamId) => {
        const stream = streamsById.get(streamId)
        if (!stream) return { streamId, status: 404, code: "NOT_FOUND" }
        if (!accessible.has(streamId)) return { streamId, status: 403, code: "FORBIDDEN" }
        const window = windows.get(streamId)!
        const streamEvents = eventsByStream.get(streamId) ?? []
        const refs = new Map<string, SharedMessageRef>()
        for (const event of streamEvents) {
          if (event.eventType !== "message_created" && event.eventType !== "message_edited") continue
          const payload = event.payload as { contentJson?: JSONContent }
          if (payload.contentJson) collectSharedMessageRefs(payload.contentJson, refs)
        }
        const reachable: Record<string, HydratedSharedMessage> = {}
        const visited = new Set<string>()
        const pending = [...refs.keys()]
        while (pending.length > 0) {
          const key = pending.pop()!
          if (visited.has(key)) continue
          visited.add(key)
          const slot = hydrated.slots[key]
          if (!slot) continue
          reachable[key] = slot
          if (slot.state !== "ok") continue
          const descendants = new Map<string, SharedMessageRef>()
          collectSharedMessageRefs(slot.contentJson, descendants)
          pending.push(...descendants.keys())
        }
        const streamSlots = toDualSlotMaps(reachable)
        return {
          streamId,
          status: 200,
          history: {
            stream: {
              ...stream,
              createdAt: stream.createdAt.toISOString(),
              updatedAt: stream.updatedAt.toISOString(),
              archivedAt: stream.archivedAt?.toISOString() ?? null,
              lastReplyAt: stream.lastReplyAt?.toISOString() ?? null,
            },
            events: streamEvents.map((event) => ({
              ...event,
              sequence: event.sequence.toString(),
              broadcastSequence: event.broadcastSequence?.toString() ?? null,
              createdAt: event.createdAt.toISOString(),
            })),
            latestSequence: (window.latestSequence ?? 0n).toString(),
            hasOlderEvents: window.hasOlderEvents,
            snapshotAt,
            syncMode: "replace",
            slots: toWireSlots(streamSlots.slots),
            sharedMessages: toWireSlots(streamSlots.sharedMessages),
          },
        }
      }),
    }
  }
}
