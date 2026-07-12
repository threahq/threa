import { describe, expect, it } from "vitest"
import type { PersonaListItem } from "@threa/types"
import { resolveCompanionSelection } from "./companion-agent-select"

function persona(overrides: Partial<PersonaListItem> & Pick<PersonaListItem, "id" | "slug" | "name">): PersonaListItem {
  return {
    description: null,
    avatarEmoji: null,
    model: "openrouter:anthropic/claude-haiku-4.5",
    kind: "custom",
    avatarUrl: null,
    isCustomized: false,
    ...overrides,
  }
}

const ARIADNE = persona({ id: "persona_ariadne", slug: "ariadne", name: "Ariadne", kind: "builtin" })
const COACH = persona({ id: "persona_coach", slug: "coach", name: "Coach" })
const SCRIBE = persona({ id: "persona_scribe", slug: "scribe", name: "Scribe" })
const ROSTER = [ARIADNE, COACH, SCRIBE]

describe("resolveCompanionSelection", () => {
  it("uses the supplied default for a null pointer instead of Ariadne", () => {
    const result = resolveCompanionSelection(ROSTER, null, COACH)
    expect(result.selectedPersonaId).toBe("persona_coach")
    expect(result.companionName).toBe("Coach")
  })

  it("prefers an explicit pointer over the supplied default", () => {
    const result = resolveCompanionSelection(ROSTER, "persona_scribe", COACH)
    expect(result.selectedPersonaId).toBe("persona_scribe")
    expect(result.companionName).toBe("Scribe")
  })

  it("degrades an off-roster pointer to the supplied default", () => {
    const result = resolveCompanionSelection(ROSTER, "persona_archived", COACH)
    expect(result.selectedPersonaId).toBe("persona_coach")
    expect(result.companionName).toBe("Coach")
  })

  it("falls back to the Ariadne-slug lookup when no default is supplied (unchanged legacy behavior)", () => {
    const result = resolveCompanionSelection(ROSTER, null)
    expect(result.selectedPersonaId).toBe("persona_ariadne")
    expect(result.companionName).toBe("Ariadne")
  })

  it("degrades to Ariadne by slug when the supplied default is undefined and the pointer is off-roster", () => {
    const result = resolveCompanionSelection(ROSTER, "persona_archived", undefined)
    expect(result.selectedPersonaId).toBe("persona_ariadne")
    expect(result.companionName).toBe("Ariadne")
  })

  it("returns the 'Ariadne' name literal when the roster is empty and no default is supplied", () => {
    const result = resolveCompanionSelection(undefined, null)
    expect(result.selectedPersonaId).toBeUndefined()
    expect(result.companionName).toBe("Ariadne")
  })
})
