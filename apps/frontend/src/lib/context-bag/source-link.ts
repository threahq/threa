import { createConversationPanelId } from "@/contexts/panel-context"

/**
 * Build the deep-link URL for a context-ref source. Used by the composer
 * strip pill and the timeline message badge so clicking the chip jumps
 * back to the exact thread / conversation / message the discussion was
 * started from.
 *
 * Threa uses `?m=<messageId>` as the canonical deep-link query param for
 * highlighting a message (see `timeline-view.tsx` + `event-item.tsx`'s
 * `highlightMessageId`; the conversation panel reads the same `m`). When
 * `originMessageId` is set we include it. A `conversationId` routes to the
 * board conversation panel instead of the stream permalink, since a
 * conversation spans streams and has no single timeline URL.
 */
export function buildContextRefSourceHref(args: {
  workspaceId: string
  sourceStreamId: string
  /** Set for conversation refs — links to the board conversation panel. */
  conversationId?: string | null
  /** Cosmetic deep-link target (`originMessageId`). Falls back to the base URL when null. */
  originMessageId?: string | null
}): string {
  if (args.conversationId) {
    const params = new URLSearchParams({ panel: createConversationPanelId(args.conversationId) })
    if (args.originMessageId) params.set("m", args.originMessageId)
    return `/w/${args.workspaceId}/board?${params.toString()}`
  }
  const base = `/w/${args.workspaceId}/s/${args.sourceStreamId}`
  return args.originMessageId ? `${base}?m=${args.originMessageId}` : base
}
