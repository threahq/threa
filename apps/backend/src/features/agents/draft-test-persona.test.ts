import { describe, expect, test } from "bun:test"
import { AgentToolNames } from "@threa/types"
import { resolveDraftTestPersona } from "./persona-repository"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID } from "./built-in-agents"

const WORKSPACE_ID = "workspace_1"

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
})
