import { cn } from "@/lib/utils"

/**
 * Vertical rhythm for a message row, shared by every surface that renders a
 * message: the stream timeline (`MessageEvent`) and the board card /
 * conversation panel (`MessageItem`). Both apply it to the *accent* row (the
 * element carrying `theme.rowAccent`) so a persona/bot tint band stays
 * contiguous across a grouped run instead of breaking into separated blocks
 * (INV-35) — the drift these constants exist to prevent.
 *
 * Heads keep a generous top pad to separate author groups, but a tight bottom
 * pad so the gap from the head body to the first continuation body matches the
 * cont-to-cont gap (4px). Group separation is carried by the next head's `pt-3`
 * (2px + 12px = 14px between groups), consistent regardless of whether the
 * previous group ended with a head or a continuation.
 */
export const MESSAGE_ROW_HEAD_PADDING = "pt-3 pb-0.5"
export const MESSAGE_ROW_CONTINUATION_PADDING = "py-0.5"

/**
 * Desktop hover toolbar wrapper for both row surfaces.
 *
 * Anchor: the wrapper's bottom edge sits exactly where the row's top padding
 * ends, so the chip floats over the previous row's tail and never covers this
 * row's own text — the last line of a grouped or multi-line message stays
 * selectable while the toolbar is up. The offsets mirror the paddings above
 * (pt-3 → 12px, py-0.5 → 2px).
 *
 * Grace: transparent padding left of the chip belongs to this row, so a diagonal
 * move from the text up to the chip crosses it instead of the previous row,
 * which would take the hover and hide the toolbar mid-reach. `pr-4` keeps the
 * chip 16px from the row's right edge.
 *
 * `reveal-actions-hover-only` reveals it on hover/focus for mouse and keyboard
 * users; `hidden sm:block` keeps it off phones, where touch reaches these
 * actions via the long-press drawer.
 */
export function messageRowToolbarClassName(continuation?: boolean): string {
  return cn(
    "reveal-actions-hover-only absolute right-0 z-10 hidden pl-8 pr-4 sm:block",
    continuation ? "bottom-[calc(100%-2px)]" : "bottom-[calc(100%-12px)]"
  )
}
