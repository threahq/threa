import type { Pool } from "pg"
import {
  THREAD_ANCHORABLE_EVENT_TYPES,
  type JSONContent,
  type LinkPreviewSummary,
  type SharedMessageRef,
} from "@threahq/types"
import { collectSharedMessageRefs, hydrateSharedMessageRefs, toDualSlotMaps, type DualSlotMaps } from "../messaging"
import type { LinkPreviewService } from "../link-previews"
import type { StreamEvent } from "./event-repository"

export function collectThreadAnchorIds(events: readonly StreamEvent[]): string[] {
  return events
    .map((event) => {
      if (event.eventType === "message_created") return (event.payload as { messageId?: string }).messageId
      if (THREAD_ANCHORABLE_EVENT_TYPES.includes(event.eventType)) return event.id
      return undefined
    })
    .filter((id): id is string => !!id)
}

export async function hydrateSlotsForEvents(
  pool: Pool,
  workspaceId: string,
  viewerId: string,
  events: StreamEvent[]
): Promise<DualSlotMaps> {
  const refs = new Map<string, SharedMessageRef>()
  for (const event of events) {
    if (event.eventType === "message_created" || event.eventType === "message_edited") {
      const payload = event.payload as { contentJson?: JSONContent }
      if (payload.contentJson) collectSharedMessageRefs(payload.contentJson, refs)
    }
  }
  if (refs.size === 0) return { slots: {}, sharedMessages: {} }
  return toDualSlotMaps(await hydrateSharedMessageRefs(pool, workspaceId, viewerId, refs.values()))
}

function areLinkPreviewArraysEqual(current: LinkPreviewSummary[] | undefined, next: LinkPreviewSummary[]): boolean {
  if (!current) return next.length === 0
  if (current.length !== next.length) return false

  return current.every((preview, index) => {
    const nextPreview = next[index]
    return (
      preview.id === nextPreview.id &&
      preview.url === nextPreview.url &&
      preview.title === nextPreview.title &&
      preview.description === nextPreview.description &&
      preview.imageUrl === nextPreview.imageUrl &&
      preview.faviconUrl === nextPreview.faviconUrl &&
      preview.siteName === nextPreview.siteName &&
      preview.contentType === nextPreview.contentType &&
      preview.position === nextPreview.position &&
      isInAppDataEqual(preview.inAppData, nextPreview.inAppData)
    )
  })
}

function isInAppDataEqual(current: LinkPreviewSummary["inAppData"], next: LinkPreviewSummary["inAppData"]): boolean {
  if (current === next) return true
  if (!current || !next) return false
  return JSON.stringify(current) === JSON.stringify(next)
}

export function applyLinkPreviewStateToEvents(
  events: StreamEvent[],
  previewMap: Map<string, LinkPreviewSummary[]>,
  dismissals: Set<string>
): StreamEvent[] {
  if (previewMap.size === 0 && dismissals.size === 0) return events

  let changed = false
  const nextEvents = events.map((event) => {
    if (event.eventType !== "message_created") return event

    const payload = event.payload as { messageId?: string; linkPreviews?: LinkPreviewSummary[] }
    if (!payload.messageId) return event

    const previews = previewMap.get(payload.messageId) ?? payload.linkPreviews
    if (!previews) return event

    const visiblePreviews = previews.filter((preview) => !dismissals.has(`${payload.messageId}:${preview.id}`))
    if (areLinkPreviewArraysEqual(payload.linkPreviews, visiblePreviews)) return event

    changed = true
    return { ...event, payload: { ...payload, linkPreviews: visiblePreviews } }
  })

  return changed ? nextEvents : events
}

export async function enrichEventsWithLinkPreviews(
  linkPreviewService: LinkPreviewService,
  workspaceId: string,
  userId: string,
  events: StreamEvent[]
): Promise<StreamEvent[]> {
  const messageIds = events
    .filter((event) => event.eventType === "message_created")
    .map((event) => (event.payload as { messageId?: string }).messageId)
    .filter((messageId): messageId is string => !!messageId)

  if (messageIds.length === 0) return events

  const [previewMap, dismissals] = await Promise.all([
    linkPreviewService.getPreviewsForMessages(workspaceId, userId, messageIds),
    linkPreviewService.getDismissals(workspaceId, userId, messageIds),
  ])

  return applyLinkPreviewStateToEvents(events, previewMap, dismissals)
}
