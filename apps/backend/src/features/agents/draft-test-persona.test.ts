import { describe, expect, test } from "bun:test"
import { AgentToolNames } from "@threahq/types"
import { resolveDraftTestPersona, type Persona } from "./persona-repository"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID } from "./built-in-agents"

const WORKSPACE_ID = "workspace_1"

const customRow: Persona = {
  id: "persona_custom_1",
  workspaceId: WORKSPACE_ID,
  slug: "helper",
  name: "Helper",
  description: null,
  avatarEmoji: null,
  avatarUrl: null,
  systemPrompt: "Help.",
  model: "openrouter:anthropic/claude-haiku-4.5",
  escalationModel: null,
  temperature: null,
  maxTokens: null,
  enabledTools: [AgentToolNames.SEND_MESSAGE],
  tonePreset: null,
  brevityPreset: null,
  tonePrompt: null,
  brevityPrompt: null,
  managedBy: "workspace",
  ownerUserId: null,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe("resolveDraftTestPersona", () => {
  test("runs the draft patch over the built-in base and strips durable-write tools", () => {
    const persona = resolveDraftTestPersona(
      {
        workspaceId: WORKSPACE_ID,
        agentId: ARIADNE_AGENT_ID,
        patch: {
          name: "Draft Ariadne",
          enabledTools: [
            AgentToolNames.SEND_MESSAGE,
            AgentToolNames.SAVE_MEMO,
            AgentToolNames.WEB_SEARCH,
            AgentToolNames.SCHEDULE_FOLLOW_UP,
          ],
        },
      },
      ARIADNE_AGENT_ID,
      WORKSPACE_ID
    )

    expect(persona).not.toBeNull()
    expect(persona!.name).toBe("Draft Ariadne")
    // save_memo and schedule_follow_up stripped; send_message + web_search kept.
    expect(persona!.enabledTools).toEqual([AgentToolNames.SEND_MESSAGE, AgentToolNames.WEB_SEARCH])
    expect(persona!.status).toBe("active")
  })

  test("returns null (→ fall back to normal resolution) when the draft is gone", () => {
    expect(resolveDraftTestPersona(null, ARIADNE_AGENT_ID, WORKSPACE_ID)).toBeNull()
  })

  test("returns null when the draft belongs to a different workspace", () => {
    const persona = resolveDraftTestPersona(
      { workspaceId: "workspace_other", agentId: ARIADNE_AGENT_ID, patch: {} },
      ARIADNE_AGENT_ID,
      WORKSPACE_ID
    )
    expect(persona).toBeNull()
  })

  test("returns null when the draft's agent id mismatches the turn's persona", () => {
    const persona = resolveDraftTestPersona(
      { workspaceId: WORKSPACE_ID, agentId: "persona_system_other", patch: {} },
      ARIADNE_AGENT_ID,
      WORKSPACE_ID
    )
    expect(persona).toBeNull()
  })

  test("returns null when the persona is not an editable visible built-in", () => {
    const persona = resolveDraftTestPersona(
      { workspaceId: WORKSPACE_ID, agentId: EMPTY_AGENT_ID, patch: {} },
      EMPTY_AGENT_ID,
      WORKSPACE_ID
    )
    expect(persona).toBeNull()
  })
  test("returns null (not throw) when the stored draft patch is corrupt", () => {
    const persona = resolveDraftTestPersona(
      { workspaceId: WORKSPACE_ID, agentId: ARIADNE_AGENT_ID, patch: { model: 42, bogusKey: true } },
      ARIADNE_AGENT_ID,
      WORKSPACE_ID
    )
    expect(persona).toBeNull()
  })

  test("applies the draft over a CUSTOM row (base supplied) and strips durable-write tools", () => {
    const persona = resolveDraftTestPersona(
      {
        workspaceId: WORKSPACE_ID,
        agentId: "persona_custom_1",
        patch: {
          name: "Draft Helper",
          systemPrompt: "Draft prompt.",
          enabledTools: [AgentToolNames.SEND_MESSAGE, AgentToolNames.SAVE_MEMO],
        },
      },
      "persona_custom_1",
      WORKSPACE_ID,
      customRow
    )
    expect(persona).not.toBeNull()
    expect(persona!.name).toBe("Draft Helper")
    expect(persona!.systemPrompt).toBe("Draft prompt.")
    // save_memo stripped for the test turn; send_message kept.
    expect(persona!.enabledTools).toEqual([AgentToolNames.SEND_MESSAGE])
  })

  test("returns null for a custom persona when no base row is supplied", () => {
    const persona = resolveDraftTestPersona(
      { workspaceId: WORKSPACE_ID, agentId: "persona_custom_1", patch: { name: "X" } },
      "persona_custom_1",
      WORKSPACE_ID
    )
    expect(persona).toBeNull()
  })

  test("returns null for a custom base belonging to another workspace", () => {
    const persona = resolveDraftTestPersona(
      { workspaceId: WORKSPACE_ID, agentId: "persona_custom_1", patch: {} },
      "persona_custom_1",
      WORKSPACE_ID,
      { ...customRow, workspaceId: "workspace_other" }
    )
    expect(persona).toBeNull()
  })
})
