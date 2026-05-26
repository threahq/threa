import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { E2eScratchpadsRepository } from "./repository"

const NOW = new Date("2026-05-26T12:00:00.000Z")

const ROW = {
  stream_id: "stream_01",
  workspace_id: "ws_1",
  enabled_at: NOW,
  owner_user_id: "usr_1",
  owner_user_key_id: "e2ek_01",
  invited_agent_kind: "none" as const,
  invited_agent_key_id: null,
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [ROW], rowCount?: number): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rowCount ?? rows.length } as QueryResult
    }),
  }
}

describe("E2eScratchpadsRepository.isE2eStream", () => {
  afterEach(() => mock.restore())

  it("returns true when the EXISTS check matches a workspace-scoped row (INV-8)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ exists: true }])

    const result = await E2eScratchpadsRepository.isE2eStream(db, "ws_1", "stream_01")

    expect(captured.text).toContain("FROM e2e_scratchpads")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("stream_id =")
    expect(captured.values).toEqual(["ws_1", "stream_01"])
    expect(result).toBe(true)
  })

  it("returns false when no row exists", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ exists: false }])

    const result = await E2eScratchpadsRepository.isE2eStream(db, "ws_1", "stream_01")
    expect(result).toBe(false)
  })

  it("returns false on empty rows (defensive against driver quirks)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const result = await E2eScratchpadsRepository.isE2eStream(db, "ws_1", "stream_01")
    expect(result).toBe(false)
  })
})

describe("E2eScratchpadsRepository.getByStreamId", () => {
  afterEach(() => mock.restore())

  it("scopes lookup to workspace_id and stream_id, maps snake_case to camelCase", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    const result = await E2eScratchpadsRepository.getByStreamId(db, "ws_1", "stream_01")

    expect(captured.text).toContain("FROM e2e_scratchpads")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("stream_id =")
    expect(captured.values).toEqual(["ws_1", "stream_01"])
    expect(result).toEqual({
      streamId: "stream_01",
      workspaceId: "ws_1",
      enabledAt: NOW,
      ownerUserId: "usr_1",
      ownerUserKeyId: "e2ek_01",
      invitedAgentKind: "none",
      invitedAgentKeyId: null,
    })
  })

  it("returns null when no row matches", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const result = await E2eScratchpadsRepository.getByStreamId(db, "ws_1", "stream_01")
    expect(result).toBeNull()
  })
})

describe("E2eScratchpadsRepository.markStreamE2e", () => {
  afterEach(() => mock.restore())

  it("inserts the row with all fields and returns the mapped result", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    const inserted = await E2eScratchpadsRepository.markStreamE2e(db, {
      streamId: "stream_01",
      workspaceId: "ws_1",
      ownerUserId: "usr_1",
      ownerUserKeyId: "e2ek_01",
      invitedAgentKind: "none",
      invitedAgentKeyId: null,
    })

    expect(captured.text).toContain("INSERT INTO e2e_scratchpads")
    expect(captured.text).toContain("RETURNING")
    expect(captured.values).toContain("stream_01")
    expect(captured.values).toContain("ws_1")
    expect(captured.values).toContain("usr_1")
    expect(captured.values).toContain("e2ek_01")
    expect(captured.values).toContain("none")
    expect(inserted.streamId).toBe("stream_01")
    expect(inserted.invitedAgentKind).toBe("none")
  })

  it("supports invited bot kind with key id", async () => {
    const captured: Captured = { text: null, values: null }
    const botRow = { ...ROW, invited_agent_kind: "bot" as const, invited_agent_key_id: "bkey_01" }
    const db = createQuerier(captured, [botRow])

    const inserted = await E2eScratchpadsRepository.markStreamE2e(db, {
      streamId: "stream_01",
      workspaceId: "ws_1",
      ownerUserId: "usr_1",
      ownerUserKeyId: "e2ek_01",
      invitedAgentKind: "bot",
      invitedAgentKeyId: "bkey_01",
    })

    expect(captured.values).toContain("bot")
    expect(captured.values).toContain("bkey_01")
    expect(inserted.invitedAgentKind).toBe("bot")
    expect(inserted.invitedAgentKeyId).toBe("bkey_01")
  })
})
