import { matchesKeyBinding } from "@/lib/keyboard-shortcuts"

/**
 * Guard for the bespoke Inbox-clear "E" listener (bypasses `useKeyboardShortcuts`,
 * see `CLEAR_INBOX_STREAM_ACTION_ID`): repeats, already-handled/IME keystrokes,
 * editable targets, and open dialogs/menus never trigger a clear.
 */
export function isClearInboxShortcutEvent(event: KeyboardEvent, binding: string | null | undefined): boolean {
  if (!binding) return false
  if (event.repeat || event.defaultPrevented || event.isComposing) return false
  const target = event.target as HTMLElement | null
  const isEditable =
    target?.tagName === "INPUT" ||
    target?.tagName === "TEXTAREA" ||
    target?.tagName === "SELECT" ||
    !!target?.isContentEditable
  if (isEditable) return false
  if (target?.closest('[role="dialog"],[role="alertdialog"],[role="menu"]')) return false
  return matchesKeyBinding(event, binding)
}

/** The hovered Inbox row, else the open stream if it's itself in the Inbox. */
export function resolveClearInboxTargetStreamId(params: {
  hoveredStreamId: string | null
  activeStreamId: string | null | undefined
  isInInbox: (streamId: string) => boolean
}): string | null {
  const { hoveredStreamId, activeStreamId, isInInbox } = params
  if (hoveredStreamId && isInInbox(hoveredStreamId)) return hoveredStreamId
  if (activeStreamId && isInInbox(activeStreamId)) return activeStreamId
  return null
}
