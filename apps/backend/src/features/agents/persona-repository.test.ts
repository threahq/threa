import { describe, expect, test } from "bun:test"
import { AgentToolNames } from "@threa/types"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID } from "./built-in-agents"
import { BUILT_IN_AGENT_CONFIG_TIMESTAMP, PersonaRepository } from "./persona-repository"

function createDb(rowsByQuery: unknown[][]) {
  const queries: unknown[] = []
  return {
    queries,
    query: async (query: unknown) => {
      queries.push(query)
      return { rows: rowsByQuery.shift() ?? [] }
    },
  } as any
}

const workspacePersonaRow = {
  id: "persona_workspace_helper",
  workspace_id: "workspace_1",
  slug: "helper",
  name: "Helper",
  description: "Workspace helper",
  avatar_emoji: ":sparkles:",
  system_prompt: "Help this workspace.",
  model: "openrouter:anthropic/claude-haiku-4.5",
  temperature: "0.2",
  max_tokens: 1000,
  enabled_tools: [AgentToolNames.READ_URL],
  managed_by: "workspace",
  status: "active",
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
}

describe("PersonaRepository built-in agent config", () => {
  test("resolves Ariadne from code without requiring a personas row", async () => {
    const persona = await PersonaRepository.findById(createDb([]), ARIADNE_AGENT_ID)

    expect(persona).toMatchObject({
      id: ARIADNE_AGENT_ID,
      slug: "ariadne",
      name: "Ariadne",
      model: "openrouter:anthropic/claude-sonnet-4.6",
      managedBy: "system",
      status: "active",
    })
    expect(persona?.systemPrompt).toContain("You are Ariadne")
    expect(persona?.enabledTools).toContain(AgentToolNames.GITHUB_PULLS)
    expect(persona?.createdAt.toISOString()).toBe(BUILT_IN_AGENT_CONFIG_TIMESTAMP.toISOString())
  })

  test("applies workspace override patches to built-ins", async () => {
    const db = createDb([
      [
        {
          agent_id: ARIADNE_AGENT_ID,
          patch: {
            model: "openrouter:anthropic/claude-haiku-4.5",
            enabledTools: [AgentToolNames.READ_URL],
          },
        },
      ],
    ])

    const persona = await PersonaRepository.findById(db, ARIADNE_AGENT_ID, "workspace_1")

    expect(persona?.model).toBe("openrouter:anthropic/claude-haiku-4.5")
    expect(persona?.enabledTools).toEqual([AgentToolNames.READ_URL])
  })

  test("rejects invalid workspace override patches", async () => {
    const db = createDb([
      [
        {
          agent_id: ARIADNE_AGENT_ID,
          patch: { model: "" },
        },
      ],
    ])

    await expect(PersonaRepository.findById(db, ARIADNE_AGENT_ID, "workspace_1")).rejects.toThrow(
      "Invalid agent config override"
    )
  })

  test("rejects workspace override patches with unknown tool names", async () => {
    const db = createDb([
      [
        {
          agent_id: ARIADNE_AGENT_ID,
          patch: { enabledTools: ["not_a_real_tool"] },
        },
      ],
    ])

    await expect(PersonaRepository.findById(db, ARIADNE_AGENT_ID, "workspace_1")).rejects.toThrow(
      "Invalid agent config override"
    )
  })

  test("scopes DB persona reads to the caller workspace (and global system rows) when workspaceId is provided", async () => {
    const db = createDb([[]])

    await PersonaRepository.findById(db, "persona_workspace_helper", "workspace_1")

    const query = db.queries[0] as { text: string; values: unknown[] }
    expect(query.text).toContain("workspace_id = $2")
    expect(query.text).toContain("workspace_id IS NULL")
    expect(query.values).toEqual(["persona_workspace_helper", "workspace_1"])
  })

  test("does not return Ariadne as default when a workspace disables it", async () => {
    const db = createDb([
      [
        {
          agent_id: ARIADNE_AGENT_ID,
          patch: { status: "disabled" },
        },
      ],
    ])

    const persona = await PersonaRepository.getSystemDefault(db, "workspace_1")

    expect(persona).toBeNull()
  })

  test("batch-resolves built-in overrides in findByIds", async () => {
    const db = createDb([
      [
        {
          agent_id: ARIADNE_AGENT_ID,
          patch: { model: "openrouter:anthropic/claude-haiku-4.5" },
        },
      ],
      [workspacePersonaRow],
    ])

    const personas = await PersonaRepository.findByIds(
      db,
      [ARIADNE_AGENT_ID, "persona_workspace_helper"],
      "workspace_1"
    )

    expect(personas.map((persona) => persona.id)).toEqual([ARIADNE_AGENT_ID, "persona_workspace_helper"])
    expect(personas[0].model).toBe("openrouter:anthropic/claude-haiku-4.5")
    expect(db.queries).toHaveLength(2)
  })

  test("lists visible built-ins and workspace personas but not internal built-ins", async () => {
    const personas = await PersonaRepository.listForWorkspace(createDb([[], [workspacePersonaRow]]), "workspace_1")

    expect(personas.map((persona) => persona.id)).toEqual([ARIADNE_AGENT_ID, "persona_workspace_helper"])
    expect(personas.some((persona) => persona.id === EMPTY_AGENT_ID)).toBe(false)
    expect(personas[1]).toMatchObject({
      workspaceId: "workspace_1",
      managedBy: "workspace",
      systemPrompt: "Help this workspace.",
    })
  })
})
