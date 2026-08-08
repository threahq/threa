import { createConversationPanelId } from "@/contexts"

/**
 * The one authority for a conversation-panel deep link (INV-35): the anchor
 * stream's timeline with the panel open, or the board when the anchor stream
 * isn't known. Shared by the drafts explorer's row hrefs and the stash picker's
 * navigate rows so the two can't drift. `stashDraftId` appends the `?stash=`
 * param the panel's composer claims on arrival.
 */
export function conversationPanelHref(
  workspaceId: string,
  conversationId: string,
  anchorStreamId: string | null,
  stashDraftId?: string
): string {
  const panelParam = `panel=${encodeURIComponent(createConversationPanelId(conversationId))}`
  const base = anchorStreamId
    ? `/w/${workspaceId}/s/${anchorStreamId}?${panelParam}`
    : `/w/${workspaceId}/board?${panelParam}`
  return stashDraftId ? `${base}&stash=${encodeURIComponent(stashDraftId)}` : base
}
