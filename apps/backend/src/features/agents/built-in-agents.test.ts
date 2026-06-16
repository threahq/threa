import { describe, expect, it } from "bun:test"
import { AgentToolNames } from "@threa/types"
import { BUILT_IN_AGENTS, ARIADNE_AGENT_ID, EMPTY_AGENT_ID, isE2eCapablePersona } from "./built-in-agents"

describe("Ariadne built-in config", () => {
  it("can load attachments for visual analysis (vision-capable model)", () => {
    // load_attachment is what lets Ariadne actually SEE an uploaded image, not
    // just read its caption — keep it enabled so that capability can't regress.
    expect(BUILT_IN_AGENTS[ARIADNE_AGENT_ID].enabledTools).toContain(AgentToolNames.LOAD_ATTACHMENT)
  })

  it("can find and read non-image document attachments", () => {
    // load_attachment is image-only; without these, Ariadne could see images
    // but had no way to read a text/PDF/Excel file's content — she'd find a
    // snippet via search and then ask the user to paste it back. Keep the full
    // find -> read -> page loop enabled.
    const { enabledTools } = BUILT_IN_AGENTS[ARIADNE_AGENT_ID]
    expect(enabledTools).toContain(AgentToolNames.SEARCH_ATTACHMENTS)
    expect(enabledTools).toContain(AgentToolNames.GET_ATTACHMENT)
    expect(enabledTools).toContain(AgentToolNames.LOAD_FILE_SECTION)
    expect(enabledTools).toContain(AgentToolNames.LOAD_PDF_SECTION)
    expect(enabledTools).toContain(AgentToolNames.LOAD_EXCEL_SECTION)
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
