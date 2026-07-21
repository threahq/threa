import { getPageActivityState } from "@/hooks/use-page-activity"
import { isMobileViewport } from "@/hooks/use-mobile"
import { isCoarsePointerDevice } from "@/hooks/use-pointer"

/**
 * The single auto-read attention formula, shared by the reactive hook
 * (`useAutoReadAttention`) and the imperative snapshot below. Focus tells you
 * which of several overlapping windows the user is working in — a fine-pointer,
 * multi-window (desktop) signal. On a phone-like device (coarse pointer AND a
 * phone-width viewport) `document.hasFocus()` is an unreliable proxy for
 * attention: mobile browsers and installed PWAs routinely report no focus while
 * the page is the foreground, and the resume `focus` event often never fires —
 * so there a visible page is "active". A coarse-but-wide device (tablet, iPad
 * split view) keeps the focus gate, so working in the adjacent pane does not
 * auto-read this one.
 */
export function computeAutoReadAttention(args: {
  isVisible: boolean
  isFocused: boolean
  isMobile: boolean
  isCoarsePointer: boolean
}): boolean {
  return args.isVisible && (args.isFocused || (args.isMobile && args.isCoarsePointer))
}

/**
 * Imperative snapshot of the auto-read attention gate, for non-React callers
 * (socket handlers). The optimistic "viewing pins read = latest" counter apply
 * must use the SAME gate as `useAutoMarkAsRead`: pinning locally without the
 * server-side confirm (which only fires when attentive) leaves the local count
 * stuck at zero while server unread grows — the sidebar-Unread-section
 * divergence bug.
 */
export function isAutoReadAttentiveNow(): boolean {
  const { isVisible, isFocused } = getPageActivityState()
  return computeAutoReadAttention({
    isVisible,
    isFocused,
    isMobile: isMobileViewport(),
    isCoarsePointer: isCoarsePointerDevice(),
  })
}
