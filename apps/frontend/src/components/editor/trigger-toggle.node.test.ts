import { describe, it, expect } from "vitest"
import { shouldRemoveTriggerOnToggle, type SuggestionPluginState, type TriggerSelection } from "./trigger-toggle"

function createSuggestionState(overrides?: Partial<SuggestionPluginState>): SuggestionPluginState {
  return {
    active: true,
    range: { from: 10, to: 11 },
    query: "",
    text: ":",
    ...overrides,
  }
}

function createSelection(overrides?: Partial<TriggerSelection>): TriggerSelection {
  return {
    from: 11,
    to: 11,
    empty: true,
    ...overrides,
  }
}

describe("shouldRemoveTriggerOnToggle", () => {
  it("returns true when trigger suggestion is active with an empty query", () => {
    const result = shouldRemoveTriggerOnToggle(":", createSuggestionState(), createSelection())
    expect(result).toBe(true)
  })

  it("returns false when suggestion query is not empty", () => {
    const result = shouldRemoveTriggerOnToggle(":", createSuggestionState({ query: "sm" }), createSelection())
    expect(result).toBe(false)
  })

  it("returns false when suggestion is inactive", () => {
    const result = shouldRemoveTriggerOnToggle(":", createSuggestionState({ active: false }), createSelection())
    expect(result).toBe(false)
  })

  it("returns false when selection is not empty", () => {
    const result = shouldRemoveTriggerOnToggle(
      ":",
      createSuggestionState(),
      createSelection({
        from: 10,
        to: 11,
        empty: false,
      })
    )
    expect(result).toBe(false)
  })

  it("returns false when trigger text does not match", () => {
    const result = shouldRemoveTriggerOnToggle(":", createSuggestionState({ text: "@" }), createSelection())
    expect(result).toBe(false)
  })
})
