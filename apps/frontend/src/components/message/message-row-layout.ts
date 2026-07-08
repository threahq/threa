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
