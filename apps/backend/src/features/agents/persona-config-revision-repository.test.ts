import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { PersonaConfigRevisionRepository } from "./persona-config-revision-repository"

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[]): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rows.length } as QueryResult
    }),
  }
}

const revisionRow = {
  id: "acrev_02",
  agent_id: "persona_system_ariadne",
  version: 2,
  patch: { name: "Renamed" },
  created_by_kind: "user",
  created_by_id: "usr_1",
  created_at: new Date("2026-07-05T00:00:00Z"),
}

describe("PersonaConfigRevisionRepository.insert", () => {
  afterEach(() => mock.restore())

  it("derives version MAX+1 in one statement, scoped to workspace+agent, returning the assigned version", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ version: 3 }])

    const result = await PersonaConfigRevisionRepository.insert(db, {
      workspaceId: "ws_1",
      agentId: "persona_system_ariadne",
      patch: { name: "Renamed" },
      createdByKind: "user",
      createdById: "usr_1",
    })

    expect(captured.text).toContain("INSERT INTO persona_config_revisions")
    expect(captured.text).toContain("COALESCE(MAX(version), 0) + 1")
    expect(captured.text).toContain("WHERE workspace_id =")
    expect(captured.text).toContain("AND agent_id =")
    // id (generated) then the scoping/author values, and the patch serialized to JSON.
    expect(captured.values).toContain("ws_1")
    expect(captured.values).toContain("persona_system_ariadne")
    expect(captured.values).toContain(JSON.stringify({ name: "Renamed" }))
    expect(captured.values).toContain("user")
    expect(captured.values).toContain("usr_1")
    expect(result).toEqual({ version: 3 })
  })
})

describe("PersonaConfigRevisionRepository.listByWorkspaceAndAgent", () => {
  afterEach(() => mock.restore())

  it("lists newest-first, workspace+agent scoped (INV-8), capped at the limit, mapping rows", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [revisionRow])

    const result = await PersonaConfigRevisionRepository.listByWorkspaceAndAgent(
      db,
      "ws_1",
      "persona_system_ariadne",
      50
    )

    expect(captured.text).toContain("FROM persona_config_revisions")
    expect(captured.text).toContain("ORDER BY version DESC")
    expect(captured.values).toEqual(["ws_1", "persona_system_ariadne", 50])
    expect(result).toEqual([
      {
        id: "acrev_02",
        agentId: "persona_system_ariadne",
        version: 2,
        patch: { name: "Renamed" },
        createdByKind: "user",
        createdById: "usr_1",
        createdAt: "2026-07-05T00:00:00.000Z",
      },
    ])
  })
})

describe("PersonaConfigRevisionRepository.findById", () => {
  afterEach(() => mock.restore())

  it("scopes by id and workspace_id (INV-8) and maps the record including agentId", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [revisionRow])

    const result = await PersonaConfigRevisionRepository.findById(db, "ws_1", "acrev_02")

    expect(captured.text).toContain("WHERE id =")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.values).toEqual(["acrev_02", "ws_1"])
    expect(result).toEqual({
      id: "acrev_02",
      agentId: "persona_system_ariadne",
      version: 2,
      patch: { name: "Renamed" },
      createdByKind: "user",
      createdById: "usr_1",
      createdAt: "2026-07-05T00:00:00.000Z",
    })
  })

  it("returns null when the revision is absent (or foreign to the workspace)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])
    expect(await PersonaConfigRevisionRepository.findById(db, "ws_1", "acrev_missing")).toBeNull()
  })
})
