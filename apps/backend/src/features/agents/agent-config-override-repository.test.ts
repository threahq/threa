import { describe, expect, test } from "bun:test"
import { AgentConfigOverrideRepository } from "./agent-config-override-repository"
import { ARIADNE_AGENT_ID } from "./built-in-agents"

function createDb(rowsByQuery: unknown[][]) {
  const queries: { text: string; values: unknown[] }[] = []
  return {
    queries,
    query: async (query: { text: string; values: unknown[] }) => {
      queries.push(query)
      return { rows: rowsByQuery.shift() ?? [] }
    },
  } as any
}

const D1 = new Date("2026-07-01T00:00:00.000Z")
const D2 = new Date("2026-07-02T00:00:00.000Z")

describe("AgentConfigOverrideRepository.upsertActive", () => {
  test("inserts a new override when none exists and none was expected", async () => {
    const db = createDb([[], [{ updated_at: D2 }]])

    const result = await AgentConfigOverrideRepository.upsertActive(db, {
      workspaceId: "workspace_1",
      agentId: ARIADNE_AGENT_ID,
      patch: { name: "Custom" },
      expectedUpdatedAt: null,
    })

    expect(result).toEqual({ outcome: "written", updatedAt: D2.toISOString() })
    // Locks the row first (INV-20) then inserts race-safely.
    expect(db.queries[0]!.text).toContain("FOR UPDATE")
    expect(db.queries[1]!.text).toContain("ON CONFLICT")
    expect(db.queries[1]!.values).toContain(JSON.stringify({ name: "Custom" }))
  })

  test("updates in place when the expected timestamp matches the current row", async () => {
    const db = createDb([[{ patch: { name: "Old" }, updated_at: D1 }], [{ updated_at: D2 }]])

    const result = await AgentConfigOverrideRepository.upsertActive(db, {
      workspaceId: "workspace_1",
      agentId: ARIADNE_AGENT_ID,
      patch: { name: "New" },
      expectedUpdatedAt: D1.toISOString(),
    })

    expect(result).toEqual({ outcome: "written", updatedAt: D2.toISOString() })
    expect(db.queries[1]!.text).toContain("UPDATE agent_config_overrides")
  })

  test("conflicts when the expected timestamp diverges from the current row", async () => {
    const db = createDb([[{ patch: { name: "Theirs" }, updated_at: D2 }]])

    const result = await AgentConfigOverrideRepository.upsertActive(db, {
      workspaceId: "workspace_1",
      agentId: ARIADNE_AGENT_ID,
      patch: { name: "Mine" },
      expectedUpdatedAt: D1.toISOString(),
    })

    expect(result).toEqual({
      outcome: "conflict",
      current: { patch: { name: "Theirs" }, updatedAt: D2.toISOString() },
    })
    // Only the locking SELECT ran — no write attempted.
    expect(db.queries).toHaveLength(1)
  })

  test("conflicts when a row exists but the caller expected none", async () => {
    const db = createDb([[{ patch: { name: "Theirs" }, updated_at: D1 }]])

    const result = await AgentConfigOverrideRepository.upsertActive(db, {
      workspaceId: "workspace_1",
      agentId: ARIADNE_AGENT_ID,
      patch: { name: "Mine" },
      expectedUpdatedAt: null,
    })

    expect(result).toEqual({
      outcome: "conflict",
      current: { patch: { name: "Theirs" }, updatedAt: D1.toISOString() },
    })
  })

  test("conflicts when a specific version was expected but the row is gone", async () => {
    const db = createDb([[]])

    const result = await AgentConfigOverrideRepository.upsertActive(db, {
      workspaceId: "workspace_1",
      agentId: ARIADNE_AGENT_ID,
      patch: { name: "Mine" },
      expectedUpdatedAt: D1.toISOString(),
    })

    expect(result).toEqual({ outcome: "conflict", current: null })
    expect(db.queries).toHaveLength(1)
  })

  test("conflicts when the create race is lost, reporting the winner's row", async () => {
    const db = createDb([
      [], // no existing row under lock
      [], // INSERT ... ON CONFLICT DO NOTHING returns nothing (someone else inserted)
      [{ patch: { name: "Winner" }, updated_at: D2 }], // re-read
    ])

    const result = await AgentConfigOverrideRepository.upsertActive(db, {
      workspaceId: "workspace_1",
      agentId: ARIADNE_AGENT_ID,
      patch: { name: "Mine" },
      expectedUpdatedAt: null,
    })

    expect(result).toEqual({
      outcome: "conflict",
      current: { patch: { name: "Winner" }, updatedAt: D2.toISOString() },
    })
  })
})

describe("AgentConfigOverrideRepository.findActiveDetailByWorkspaceAndAgent", () => {
  test("returns the patch and ISO-serialized updated_at", async () => {
    const db = createDb([[{ patch: { model: "openrouter:anthropic/claude-haiku-4.5" }, updated_at: D1 }]])

    const detail = await AgentConfigOverrideRepository.findActiveDetailByWorkspaceAndAgent(
      db,
      "workspace_1",
      ARIADNE_AGENT_ID
    )

    expect(detail).toEqual({
      patch: { model: "openrouter:anthropic/claude-haiku-4.5" },
      updatedAt: D1.toISOString(),
    })
  })

  test("returns null when no active override exists", async () => {
    const detail = await AgentConfigOverrideRepository.findActiveDetailByWorkspaceAndAgent(
      createDb([[]]),
      "workspace_1",
      ARIADNE_AGENT_ID
    )
    expect(detail).toBeNull()
  })
})
