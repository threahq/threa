import { describe, expect, it } from "bun:test"
import { AgentToolNames } from "@threa/types"
import { BUILT_IN_AGENTS, ARIADNE_AGENT_ID, EMPTY_AGENT_ID, isE2eCapablePersona } from "./built-in-agents"

describe("Ariadne built-in config", () => {
  it("can find and read attachments of any type", () => {
    // read_attachment is the one reader for images, PDFs, text, and
    // spreadsheets; search_attachments is how Ariadne finds a file she doesn't
    // already have an id for. Without read_attachment she could see an image
    // but had no way to read a text/PDF/Excel file — she'd find a snippet and
    // then ask the user to paste it back. Keep the find -> read loop enabled.
    const { enabledTools } = BUILT_IN_AGENTS[ARIADNE_AGENT_ID]
    expect(enabledTools).toContain(AgentToolNames.SEARCH_ATTACHMENTS)
    expect(enabledTools).toContain(AgentToolNames.READ_ATTACHMENT)
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
