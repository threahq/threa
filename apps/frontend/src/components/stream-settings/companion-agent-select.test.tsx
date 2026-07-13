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
    status: "active",
    ...overrides,
  }
}

const ARIADNE = persona({ id: "persona_ariadne", slug: "ariadne", name: "Ariadne", kind: "builtin" })
const COACH = persona({ id: "persona_coach", slug: "coach", name: "Coach" })
const SCRIBE = persona({ id: "persona_scribe", slug: "scribe", name: "Scribe" })
const ROSTER = [ARIADNE, COACH, SCRIBE]

describe("resolveCompanionSelection", () => {
  it("uses the supplied default for a null pointer instead of Ariadne", () => {
    expect(resolveCompanionSelection(ROSTER, null, COACH)).toEqual({
      selectedPersonaId: "persona_coach",
      selectedPersona: COACH,
      companionName: "Coach",
    })
  })

  it("prefers an explicit pointer over the supplied default", () => {
    expect(resolveCompanionSelection(ROSTER, "persona_scribe", COACH)).toEqual({
      selectedPersonaId: "persona_scribe",
      selectedPersona: SCRIBE,
      companionName: "Scribe",
    })
  })

  it("degrades an off-roster pointer to the supplied default", () => {
    expect(resolveCompanionSelection(ROSTER, "persona_archived", COACH)).toEqual({
      selectedPersonaId: "persona_coach",
      selectedPersona: COACH,
      companionName: "Coach",
    })
  })

  it("falls back to the Ariadne-slug lookup when no default is supplied (unchanged legacy behavior)", () => {
    expect(resolveCompanionSelection(ROSTER, null)).toEqual({
      selectedPersonaId: "persona_ariadne",
      selectedPersona: ARIADNE,
      companionName: "Ariadne",
    })
  })

  it("degrades to Ariadne by slug when the supplied default is undefined and the pointer is off-roster", () => {
    expect(resolveCompanionSelection(ROSTER, "persona_archived", undefined)).toEqual({
      selectedPersonaId: "persona_ariadne",
      selectedPersona: ARIADNE,
      companionName: "Ariadne",
    })
  })

  it("returns the 'Ariadne' name literal when the roster is empty and no default is supplied", () => {
    expect(resolveCompanionSelection(undefined, null)).toEqual({
      selectedPersonaId: undefined,
      selectedPersona: undefined,
      companionName: "Ariadne",
    })
  })
})
