import { describe, expect, it } from "bun:test"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID, isE2eCapablePersona } from "./built-in-agents"

describe("isE2eCapablePersona", () => {
  it("is true for Ariadne (the enclave persona)", () => {
    expect(isE2eCapablePersona(ARIADNE_AGENT_ID)).toBe(true)
  })

  it("is false for the locked-down Empty agent", () => {
    expect(isE2eCapablePersona(EMPTY_AGENT_ID)).toBe(false)
  })

  it("is false for an unknown / non-built-in persona id", () => {
    expect(isE2eCapablePersona("persona_user_made")).toBe(false)
  })
})
