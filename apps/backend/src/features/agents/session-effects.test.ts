import { describe, test, expect } from "bun:test"
import { EFFECTS_PER_SESSION_MAX, type AgentToolEffect } from "@threa/types"
import { collectSessionEffects } from "./session-effects"

const step = (...effects: AgentToolEffect[]) => ({ effects })

describe("collectSessionEffects", () => {
  test("keeps step order and skips steps that wrote nothing", () => {
    expect(
      collectSessionEffects([
        step({ kind: "settings", target: "theme", before: "light", after: "dark" }),
        {},
        step({ kind: "memo", label: "Tide notes", target: "memo_1" }),
      ])
    ).toEqual([
      { kind: "settings", target: "theme", before: "light", after: "dark" },
      { kind: "memo", label: "Tide notes", target: "memo_1" },
    ])
  })

  // "Switch me to dark — actually, put it back." Keeping only the first write
  // would report light → dark while the stored value is light.
  test("spans the turn when the same thing is written twice", () => {
    expect(
      collectSessionEffects([
        step({ kind: "settings", target: "timezone", before: "Europe/Stockholm", after: "Asia/Tokyo" }),
        step({ kind: "settings", target: "timezone", before: "Asia/Tokyo", after: "Europe/Oslo" }),
      ])
    ).toEqual([{ kind: "settings", target: "timezone", before: "Europe/Stockholm", after: "Europe/Oslo" }])
  })

  test("drops the diff when the turn ended where it began", () => {
    expect(
      collectSessionEffects([
        step({ kind: "settings", target: "theme", before: "light", after: "dark" }),
        step({ kind: "settings", target: "theme", before: "dark", after: "light" }),
      ])
    ).toEqual([{ kind: "settings", target: "theme" }])
  })

  test("collapses repeated writes that carry no diff at all", () => {
    expect(collectSessionEffects([step({ kind: "brief" }), step({ kind: "brief" }), step({ kind: "brief" })])).toEqual([
      { kind: "brief" },
    ])
  })

  test("distinct targets never collide", () => {
    expect(
      collectSessionEffects([
        step(
          { kind: "settings", target: "theme", before: "light", after: "dark" },
          { kind: "settings", target: "timezone", before: "UTC", after: "Asia/Tokyo" }
        ),
      ])
    ).toHaveLength(2)
  })

  // Three writes to the same key where the middle pair cancels: the session
  // still went from light to system, and folding the drop into the loop would
  // have erased the starting value before the third write merged.
  test("keeps the true starting value across an intermediate round-trip", () => {
    expect(
      collectSessionEffects([
        step({ kind: "settings", target: "theme", before: "light", after: "dark" }),
        step({ kind: "settings", target: "theme", before: "dark", after: "light" }),
        step({ kind: "settings", target: "theme", before: "light", after: "system" }),
      ])
    ).toEqual([{ kind: "settings", target: "theme", before: "light", after: "system" }])
  })

  test("caps the aggregate", () => {
    const many = Array.from({ length: EFFECTS_PER_SESSION_MAX + 10 }, (_, i) =>
      step({ kind: "memo" as const, target: `memo_${i}` })
    )

    expect(collectSessionEffects(many)).toHaveLength(EFFECTS_PER_SESSION_MAX)
  })

  // A later write to something already collected must still merge once the cap
  // is reached — otherwise the cap would freeze a stale `after`.
  test("still merges into an existing entry after the cap is reached", () => {
    const filler = Array.from({ length: EFFECTS_PER_SESSION_MAX }, (_, i) =>
      step({ kind: "memo" as const, target: `memo_${i}` })
    )
    const result = collectSessionEffects([
      step({ kind: "settings", target: "theme", before: "light", after: "dark" }),
      ...filler,
      step({ kind: "settings", target: "theme", before: "dark", after: "system" }),
    ])

    expect(result[0]).toEqual({ kind: "settings", target: "theme", before: "light", after: "system" })
    expect(result).toHaveLength(EFFECTS_PER_SESSION_MAX)
  })
})
