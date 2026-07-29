import { toast } from "sonner"
import { createConversationPanelId } from "@/contexts/panel-context"

/**
 * Absolute, shareable URL for a stream's main view. The "copy link" affordances
 * (sidebar/top-bar context menus and the mod+L shortcut) all point here so a
 * thread, channel, DM, or scratchpad opens as the main view when the link is
 * followed.
 */
export function buildStreamLink(workspaceId: string, streamId: string): string {
  return `${window.location.origin}/w/${workspaceId}/s/${streamId}`
}

/**
 * Absolute, shareable URL for a delegation. Points at the first-class
 * `/delegations/:id` route (a redirect page that resolves the delegation and
 * bounces to its card row), so a pasted link renders as a titled chip + card
 * (mirrors {@link buildConversationLink}). Copy surfaces write this string.
 */
export function buildDelegationLink(workspaceId: string, delegationId: string): string {
  return `${window.location.origin}${buildDelegationPath(workspaceId, delegationId)}`
}

/**
 * Relative router path (no origin) for a delegation — the form React-Router
 * `<Link to>` consumes. {@link buildDelegationLink} prepends the origin for
 * clipboard use; both keep the route shape in this one place (mirrors
 * {@link buildConversationPanelPath}).
 */
export function buildDelegationPath(workspaceId: string, delegationId: string): string {
  return `/w/${workspaceId}/delegations/${delegationId}`
}

/**
 * Absolute, shareable URL that reopens a conversation in the side panel
 * (Mechanism B). A conversation is not a stream — it spans its root + threads —
 * so its link can't be a stream permalink: it opens the board (the panel host
 * that doesn't itself consume `?m=`) with the `conv:<id>` panel, optionally
 * deep-linked to a single message via `?m=`. The conversation panel honors that
 * `m` (scroll + flash); the board page ignores it, so there's no competing
 * main-view highlight. Pairs with {@link buildStreamLink} as the conversation-
 * surface counterpart to a stream permalink.
 */
export function buildConversationLink(workspaceId: string, conversationId: string, messageId?: string): string {
  return `${window.location.origin}${buildConversationPanelPath(workspaceId, conversationId, messageId)}`
}

/**
 * Relative router path (no origin) that reopens a conversation in the side
 * panel — the form React-Router `<Link to>` and the saved/activity deep-links
 * consume. {@link buildConversationLink} prepends the origin for clipboard use;
 * both keep the `?panel=conv:<id>&m=` route shape in this one place.
 */
export function buildConversationPanelPath(workspaceId: string, conversationId: string, messageId?: string): string {
  const params = new URLSearchParams({ panel: createConversationPanelId(conversationId) })
  if (messageId) params.set("m", messageId)
  return `/w/${workspaceId}/board?${params.toString()}`
}

/**
 * Copy a stream link to the clipboard with user feedback. Centralized so every
 * copy-link surface reports success/failure the same way (mirrors the message
 * permalink action in message-actions.ts).
 */
export async function copyStreamLink(workspaceId: string, streamId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(buildStreamLink(workspaceId, streamId))
    toast.success("Link copied") // INV-63-allow: clipboard copy from a menu/shortcut has no inline anchor
  } catch {
    toast.error("Failed to copy link")
  }
}

/** Copy a conversation panel link (optionally message-deep-linked) with the
 *  same success/failure feedback as {@link copyStreamLink}. */
export async function copyConversationLink(
  workspaceId: string,
  conversationId: string,
  messageId?: string
): Promise<void> {
  try {
    await navigator.clipboard.writeText(buildConversationLink(workspaceId, conversationId, messageId))
    toast.success("Link copied") // INV-63-allow: clipboard copy from a menu/shortcut has no inline anchor
  } catch {
    toast.error("Failed to copy link")
  }
}

/**
 * `?m=` deep-link targets are message ids or, for non-message rows (delegation
 * cards), raw `event_…` ids — the prefixes never collide, so one matcher serves
 * every deep-link path (mirrors findMessageItemIndex). Every in-window check a
 * deep link flows through must use this, or an event-id target wedges that path
 * on its give-up/timeout branch.
 */
export function matchesDeepLinkTarget(event: { id: string; payload: unknown }, target: string): boolean {
  return (event.payload as { messageId?: string })?.messageId === target || event.id === target
}
