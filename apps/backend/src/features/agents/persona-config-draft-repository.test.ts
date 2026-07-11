import { describe, expect, test } from "bun:test"
import { PersonaConfigDraftRepository } from "./persona-config-draft-repository"
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

const WORKSPACE_ID = "workspace_1"
const CALLER_ID = "usr_1"
const D1 = new Date("2026-07-01T00:00:00.000Z")

describe("PersonaConfigDraftRepository.upsert", () => {
  test("race-safe single-statement upsert keyed on (workspace, agent, creator)", async () => {
    const db = createDb([[{ patch: { name: "Draft" }, test_stream_id: null, updated_at: D1 }]])

    const detail = await PersonaConfigDraftRepository.upsert(db, {
      workspaceId: WORKSPACE_ID,
      agentId: ARIADNE_AGENT_ID,
      createdBy: CALLER_ID,
      patch: { name: "Draft" },
    })

    expect(detail).toEqual({ patch: { name: "Draft" }, testStreamId: null, updatedAt: D1.toISOString() })
    // One statement, insert-or-update — concurrent saves can't clobber (INV-20).
    expect(db.queries).toHaveLength(1)
    expect(db.queries[0]!.text).toContain("ON CONFLICT (workspace_id, agent_id, created_by)")
    expect(db.queries[0]!.text).toContain("DO UPDATE SET patch = EXCLUDED.patch")
    expect(db.queries[0]!.values).toContain(JSON.stringify({ name: "Draft" }))
  })
})

describe("PersonaConfigDraftRepository.findByOwner", () => {
  test("returns the caller's draft with ISO-serialized updated_at", async () => {
    const db = createDb([[{ patch: { name: "Draft" }, test_stream_id: "stream_test", updated_at: D1 }]])

    const detail = await PersonaConfigDraftRepository.findByOwner(db, WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(detail).toEqual({ patch: { name: "Draft" }, testStreamId: "stream_test", updatedAt: D1.toISOString() })
  })

  test("returns null when the caller has no draft", async () => {
    const detail = await PersonaConfigDraftRepository.findByOwner(
      createDb([[]]),
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      CALLER_ID
    )
    expect(detail).toBeNull()
  })
})

describe("PersonaConfigDraftRepository.findByTestStreamId", () => {
  test("maps a bound test stream to its draft identity, scoped by workspace", async () => {
    const db = createDb([[{ id: "pcd_1", workspace_id: WORKSPACE_ID, agent_id: ARIADNE_AGENT_ID }]])

    const found = await PersonaConfigDraftRepository.findByTestStreamId(db, WORKSPACE_ID, "stream_test")

    expect(found).toEqual({ id: "pcd_1", workspaceId: WORKSPACE_ID, agentId: ARIADNE_AGENT_ID })
    // Workspace-scoped read (INV-8): the filter is part of the query.
    expect(db.queries[0]!.text).toContain("workspace_id")
    expect(db.queries[0]!.values).toContain(WORKSPACE_ID)
  })

  test("returns null when the stream is not a bound test stream", async () => {
    const found = await PersonaConfigDraftRepository.findByTestStreamId(createDb([[]]), WORKSPACE_ID, "stream_other")
    expect(found).toBeNull()
  })
})

describe("PersonaConfigDraftRepository.findById", () => {
  test("loads a draft identity scoped by workspace (INV-8)", async () => {
    const db = createDb([
      [
        {
          id: "pcd_1",
          workspace_id: WORKSPACE_ID,
          agent_id: ARIADNE_AGENT_ID,
          created_by: CALLER_ID,
          patch: { name: "Draft" },
          test_stream_id: "stream_test",
        },
      ],
    ])

    const found = await PersonaConfigDraftRepository.findById(db, WORKSPACE_ID, "pcd_1")

    expect(found).toEqual({
      id: "pcd_1",
      workspaceId: WORKSPACE_ID,
      agentId: ARIADNE_AGENT_ID,
      createdBy: CALLER_ID,
      patch: { name: "Draft" },
      testStreamId: "stream_test",
    })
    expect(db.queries[0]!.text).toContain("workspace_id")
    expect(db.queries[0]!.values).toContain(WORKSPACE_ID)
  })
})

describe("PersonaConfigDraftRepository.bindTestStream", () => {
  test("upserts test_stream_id without ever clobbering an existing patch (INV-20)", async () => {
    const db = createDb([[]])

    await PersonaConfigDraftRepository.bindTestStream(db, {
      workspaceId: WORKSPACE_ID,
      agentId: ARIADNE_AGENT_ID,
      createdBy: CALLER_ID,
      testStreamId: "stream_new",
    })

    expect(db.queries).toHaveLength(1)
    const text = db.queries[0]!.text
    // Single race-safe statement: insert an empty-patch row, or on conflict update
    // ONLY test_stream_id — a concurrent real saveDraft's patch survives.
    expect(text).toContain("INSERT INTO persona_config_drafts")
    expect(text).toContain("ON CONFLICT (workspace_id, agent_id, created_by)")
    expect(text).toContain("DO UPDATE SET test_stream_id = EXCLUDED.test_stream_id")
    expect(text).not.toContain("patch = EXCLUDED.patch")
    expect(db.queries[0]!.values).toContain("stream_new")
  })
})

describe("PersonaConfigDraftRepository.deleteByOwner", () => {
  test("returns the bound test stream id so the caller can archive it", async () => {
    const db = createDb([[{ test_stream_id: "stream_test" }]])

    const deleted = await PersonaConfigDraftRepository.deleteByOwner(db, WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(deleted).toEqual({ testStreamId: "stream_test" })
    expect(db.queries[0]!.text).toContain("DELETE FROM persona_config_drafts")
    expect(db.queries[0]!.text).toContain("RETURNING test_stream_id")
  })

  test("returns null when there was no draft (idempotent discard)", async () => {
    const deleted = await PersonaConfigDraftRepository.deleteByOwner(
      createDb([[]]),
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      CALLER_ID
    )
    expect(deleted).toBeNull()
  })
})
