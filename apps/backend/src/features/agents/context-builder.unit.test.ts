/**
 * Unit tests for `trimToCharBudget` — the C-2b budgeted-window fill.
 *
 * Contract: given a chronological (oldest-first) list, keep the newest suffix
 * that fits within the char budget, always keeping at least the newest message
 * (the trigger). Pure function, no DB.
 */

import { describe, test, expect } from "bun:test"
import { trimToCharBudget } from "./context-builder"

const msg = (contentMarkdown: string) => ({ contentMarkdown })

describe("trimToCharBudget", () => {
  test("returns the same array when empty or single", () => {
    const empty: { contentMarkdown: string }[] = []
    expect(trimToCharBudget(empty, 10)).toBe(empty)

    const one = [msg("hello")]
    expect(trimToCharBudget(one, 1)).toBe(one)
  })

  test("returns the same array when everything fits", () => {
    const all = [msg("aa"), msg("bb"), msg("cc")]
    expect(trimToCharBudget(all, 100)).toBe(all)
  })

  test("keeps the newest suffix within budget, dropping older messages", () => {
    const messages = [msg("11111"), msg("22222"), msg("33333")] // 5 chars each
    // Budget 10 holds the newest two (10 chars); a third would overflow.
    expect(trimToCharBudget(messages, 10)).toEqual([msg("22222"), msg("33333")])
  })

  test("always keeps at least the newest message even when it alone overflows", () => {
    const messages = [msg("old"), msg("x".repeat(50))]
    expect(trimToCharBudget(messages, 10)).toEqual([msg("x".repeat(50))])
  })
})
