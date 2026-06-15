import { describe, expect, it } from "bun:test"
import { AgentToolNames } from "@threa/types"
import { BUILT_IN_AGENTS, ARIADNE_AGENT_ID, EMPTY_AGENT_ID, isE2eCapablePersona } from "./built-in-agents"

describe("Ariadne built-in config", () => {
  it("can load attachments for visual analysis (vision-capable model)", () => {
    // load_attachment is what lets Ariadne actually SEE an uploaded image, not
    // just read its caption — keep it enabled so that capability can't regress.
    expect(BUILT_IN_AGENTS[ARIADNE_AGENT_ID].enabledTools).toContain(AgentToolNames.LOAD_ATTACHMENT)
  })
})

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
