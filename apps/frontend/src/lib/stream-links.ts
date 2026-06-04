import { toast } from "sonner"

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
 * Copy a stream link to the clipboard with user feedback. Centralized so every
 * copy-link surface reports success/failure the same way (mirrors the message
 * permalink action in message-actions.ts).
 */
export async function copyStreamLink(workspaceId: string, streamId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(buildStreamLink(workspaceId, streamId))
    toast.success("Link copied")
  } catch {
    toast.error("Failed to copy link")
  }
}
