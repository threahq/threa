import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { AgentToolNames } from "@threahq/types"
import {
  BUILT_IN_AGENTS,
  ARIADNE_AGENT_ID,
  EMPTY_AGENT_ID,
  applyBuiltInAgentPatch,
  isE2eCapablePersona,
} from "./built-in-agents"

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

  it("can start a subagent", () => {
    expect(BUILT_IN_AGENTS[ARIADNE_AGENT_ID].enabledTools).toContain(AgentToolNames.START_SUBAGENT)
  })

  it("has an escalation model distinct from the default model (roadmap 2.3)", () => {
    const { model, escalationModel } = BUILT_IN_AGENTS[ARIADNE_AGENT_ID]
    expect(escalationModel).toBe("openrouter:openai/gpt-5.6-terra")
    // Escalation to the same id would be a no-op — the rule could never fire.
    expect(escalationModel).not.toBe(model)
  })

  it("uses model ids documented in docs/model-reference.md (INV-16)", () => {
    const reference = readFileSync(join(__dirname, "../../../../../docs/model-reference.md"), "utf-8")
    for (const agent of Object.values(BUILT_IN_AGENTS)) {
      expect(reference).toContain(agent.model)
      if (agent.escalationModel) expect(reference).toContain(agent.escalationModel)
    }
  })
})

describe("applyBuiltInAgentPatch", () => {
  it("round-trips an escalationModel override, including disabling it", () => {
    const base = BUILT_IN_AGENTS[ARIADNE_AGENT_ID]
    const context = { workspaceId: "ws_1", agentId: ARIADNE_AGENT_ID }

    const overridden = applyBuiltInAgentPatch(
      base,
      { escalationModel: "openrouter:anthropic/claude-opus-4.5" },
      context
    )
    expect(overridden.escalationModel).toBe("openrouter:anthropic/claude-opus-4.5")

    const disabled = applyBuiltInAgentPatch(base, { escalationModel: null }, context)
    expect(disabled.escalationModel).toBeNull()
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
