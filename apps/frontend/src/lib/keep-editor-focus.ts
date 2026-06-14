import type { MouseEvent as ReactMouseEvent } from "react"

/**
 * Props to spread onto a Radix `PopoverContent` (or `DropdownMenuContent`) that
 * opens from the rich-text editor's chrome, when opening or clicking inside it
 * must NOT pull focus off the editor.
 *
 * Two callers, two motivations, one mechanism:
 *   - The composer Drafts/Scheduled pickers pass `enabled = isMobile`: a blur
 *     tears down the mobile soft keyboard, which re-flows the whole composer and
 *     drops the popover (and its Save/Schedule action) somewhere else mid-tap.
 *   - The editor toolbar's table-controls popover passes `enabled = true`: its
 *     commands operate on the editor's live selection, so focus must stay on the
 *     editor on every platform.
 *
 * Two things steal focus and both are suppressed when enabled:
 *   - Radix moves focus into the content on open and back to the trigger on
 *     close. `onOpenAutoFocus`/`onCloseAutoFocus` are prevented so focus never
 *     leaves the editor.
 *   - Native focus-follows-pointer when a button inside the popover is tapped.
 *     A `mousedown` `preventDefault` keeps focus on the editor (the button's
 *     `click` still fires). Native inputs (the scheduled-message date/time
 *     fields) are exempt so their platform pickers still open, and elements
 *     outside this DOM node — nested portaled menus whose synthetic events
 *     bubble back through the React tree — are left untouched.
 *
 * When `enabled` is false the popover gets no handlers and Radix manages focus
 * normally (desktop keyboard navigation for the pickers).
 */
export interface KeepEditorFocusProps {
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
  onMouseDown?: (event: ReactMouseEvent<HTMLElement>) => void
}

export function keepEditorFocusProps(enabled: boolean): KeepEditorFocusProps {
  if (!enabled) return {}
  return {
    onOpenAutoFocus: (event) => event.preventDefault(),
    onCloseAutoFocus: (event) => event.preventDefault(),
    onMouseDown: (event) => {
      const target = event.target as HTMLElement
      // Let native inputs (date/time pickers) take focus so their platform UI opens.
      if (target.closest("input, textarea, select, [contenteditable='true']")) return
      // Only suppress focus theft for elements physically inside this popover —
      // nested portaled menus bubble here through the React tree but must keep
      // their own native focus.
      if (!event.currentTarget.contains(target)) return
      event.preventDefault()
    },
  }
}
