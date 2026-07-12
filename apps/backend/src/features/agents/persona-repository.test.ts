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
  escalation_model: null,
  temperature: "0.2",
  max_tokens: 1000,
  enabled_tools: [AgentToolNames.READ_URL],
  tone_prompt: null,
  brevity_prompt: null,
  avatar_url: null,
  managed_by: "workspace",
  status: "active",
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
}

const customConfig = {
  name: "Helper",
  description: "Workspace helper",
  avatarEmoji: ":sparkles:",
  systemPrompt: "Help this workspace.",
  model: "openrouter:anthropic/claude-haiku-4.5",
  escalationModel: null,
  temperature: 0.2,
  maxTokens: 1000,
  enabledTools: [AgentToolNames.READ_URL],
  tonePrompt: null,
  brevityPrompt: null,
}

describe("PersonaRepository built-in agent config", () => {
  test("resolves Ariadne from code without requiring a personas row", async () => {
    const persona = await PersonaRepository.findById(createDb([]), ARIADNE_AGENT_ID)

    expect(persona).toMatchObject({
      id: ARIADNE_AGENT_ID,
      slug: "ariadne",
      name: "Ariadne",
      model: "openrouter:anthropic/claude-sonnet-5",
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

  test("maps the new custom columns (escalation/slots) through mapRowToPersona", async () => {
    const row = {
      ...workspacePersonaRow,
      escalation_model: "openrouter:anthropic/claude-opus-4.8",
      tone_prompt: "Be blunt.",
      brevity_prompt: "Be terse.",
    }
    const persona = await PersonaRepository.findById(createDb([[row]]), "persona_workspace_helper", "workspace_1")
    expect(persona).toMatchObject({
      escalationModel: "openrouter:anthropic/claude-opus-4.8",
      tonePrompt: "Be blunt.",
      brevityPrompt: "Be terse.",
    })
  })
})

describe("PersonaRepository custom write layer", () => {
  test("findWorkspacePersona hard-scopes to managed_by=workspace AND the caller workspace", async () => {
    const db = createDb([[]])
    await PersonaRepository.findWorkspacePersona(db, "workspace_1", "persona_workspace_helper")

    const query = db.queries[0] as { text: string; values: unknown[] }
    expect(query.text).toContain("workspace_id = $2")
    expect(query.text).toContain("managed_by = 'workspace'")
    expect(query.values).toEqual(["persona_workspace_helper", "workspace_1"])
  })

  test("resolveEditable short-circuits a built-in without a DB read", async () => {
    const db = createDb([])
    const editable = await PersonaRepository.resolveEditable(db, "workspace_1", ARIADNE_AGENT_ID)
    expect(editable).toMatchObject({ kind: "builtin" })
    expect(db.queries).toHaveLength(0)
  })

  test("resolveEditable returns a custom row (any status, incl. archived)", async () => {
    const db = createDb([[{ ...workspacePersonaRow, status: "archived" }]])
    const editable = await PersonaRepository.resolveEditable(db, "workspace_1", "persona_workspace_helper")
    expect(editable).toMatchObject({ kind: "custom", row: { id: "persona_workspace_helper", status: "archived" } })
  })

  test("resolveEditable is null for a foreign-workspace / unknown id", async () => {
    const db = createDb([[]])
    expect(await PersonaRepository.resolveEditable(db, "workspace_1", "persona_other")).toBeNull()
  })

  test("insertWorkspacePersona writes managed_by=workspace/status=active and the config columns", async () => {
    const db = createDb([[workspacePersonaRow]])
    const persona = await PersonaRepository.insertWorkspacePersona(db, {
      workspaceId: "workspace_1",
      slug: "helper",
      config: customConfig,
    })
    const query = db.queries[0] as { text: string; values: unknown[] }
    expect(query.text).toContain("INSERT INTO personas")
    expect(query.text).toContain("'workspace', 'active'")
    expect(query.values).toContain("workspace_1")
    expect(query.values).toContain("helper")
    expect(persona).toMatchObject({ id: "persona_workspace_helper", managedBy: "workspace" })
  })

  test("updateWorkspacePersona conflicts when expectedUpdatedAt mismatches the locked row", async () => {
    const db = createDb([[workspacePersonaRow]]) // FOR UPDATE select returns the row
    const result = await PersonaRepository.updateWorkspacePersona(db, {
      workspaceId: "workspace_1",
      personaId: "persona_workspace_helper",
      expectedUpdatedAt: "1999-01-01T00:00:00.000Z",
      config: customConfig,
    })
    expect(result.outcome).toBe("conflict")
    // Only the FOR UPDATE select ran — no UPDATE on a conflict.
    expect(db.queries).toHaveLength(1)
  })

  test("updateWorkspacePersona writes when the OCC token matches", async () => {
    const locked = { ...workspacePersonaRow, updated_at: new Date("2026-02-02T00:00:00.000Z") }
    const written = { ...locked, name: "Renamed", updated_at: new Date("2026-02-03T00:00:00.000Z") }
    const db = createDb([[locked], [written]])
    const result = await PersonaRepository.updateWorkspacePersona(db, {
      workspaceId: "workspace_1",
      personaId: "persona_workspace_helper",
      expectedUpdatedAt: "2026-02-02T00:00:00.000Z",
      config: { ...customConfig, name: "Renamed" },
    })
    expect(result).toMatchObject({ outcome: "written", updatedAt: "2026-02-03T00:00:00.000Z" })
    const updateQuery = db.queries[1] as { text: string }
    expect(updateQuery.text).toContain("UPDATE personas SET")
    expect(updateQuery.text).toContain("managed_by = 'workspace'")
  })

  test("updateWorkspacePersona conflicts (current:null) when no scoped row exists", async () => {
    const db = createDb([[]])
    const result = await PersonaRepository.updateWorkspacePersona(db, {
      workspaceId: "workspace_1",
      personaId: "persona_missing",
      expectedUpdatedAt: null,
      config: customConfig,
    })
    expect(result).toEqual({ outcome: "conflict", current: null })
  })

  test("setStatus hard-scopes to managed_by=workspace AND the workspace", async () => {
    const db = createDb([[{ ...workspacePersonaRow, status: "archived" }]])
    const row = await PersonaRepository.setStatus(db, {
      workspaceId: "workspace_1",
      personaId: "persona_workspace_helper",
      status: "archived",
    })
    const query = db.queries[0] as { text: string }
    expect(query.text).toContain("UPDATE personas SET status")
    expect(query.text).toContain("managed_by = 'workspace'")
    expect(row).toMatchObject({ status: "archived" })
  })

  test("setStatus returns null when no custom row matches", async () => {
    const db = createDb([[]])
    expect(
      await PersonaRepository.setStatus(db, { workspaceId: "workspace_1", personaId: "x", status: "active" })
    ).toBeNull()
  })

  test("updateAvatarUrl hard-scopes to managed_by=workspace AND the workspace and maps avatar_url", async () => {
    const db = createDb([
      [{ ...workspacePersonaRow, avatar_url: "avatars/workspace_1/personas/persona_workspace_helper/222" }],
    ])
    const row = await PersonaRepository.updateAvatarUrl(db, {
      workspaceId: "workspace_1",
      personaId: "persona_workspace_helper",
      avatarUrl: "avatars/workspace_1/personas/persona_workspace_helper/222",
    })
    const query = db.queries[0] as { text: string }
    expect(query.text).toContain("UPDATE personas SET avatar_url")
    expect(query.text).toContain("managed_by = 'workspace'")
    expect(query.text).toContain("workspace_id =")
    expect(row).toMatchObject({ avatarUrl: "avatars/workspace_1/personas/persona_workspace_helper/222" })
  })

  test("updateAvatarUrl returns null when no custom row matches (a 404)", async () => {
    const db = createDb([[]])
    expect(
      await PersonaRepository.updateAvatarUrl(db, { workspaceId: "workspace_1", personaId: "x", avatarUrl: null })
    ).toBeNull()
  })
})
