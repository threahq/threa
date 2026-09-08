/**
 * Effort levels the Claude Code TUI accepts as `/effort <level>` (verified
 * against v2.1.199 — the slider steps, plus `ultracode` = xhigh + workflows).
 * Advertised as `thinkingLevels` so Threa's canonical `/thinking` command
 * surfaces them as picker options; the channel actuates the pick as `/effort`.
 * A spawn's `--thinking` takes a shorter list: `ultracode` has no launch flag
 * (see `thinkingLevels` on the harness runtime catalog).
 */
export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const
