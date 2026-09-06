import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { BotAccessRequestStatuses } from "@threahq/types"
import { BotAccessRequestRepository } from "./repository"

const NOW = new Date("2026-07-13T12:00:00.000Z")

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bareq_1",
    workspace_id: "ws_1",
    bot_id: "bot_1",
    stream_id: "stream_1",
    delegation_id: "dlg_1",
    bot_name: "Kris's MacBook",
    delegation_title: "Fix the build",
    requested_by_label: "Kris's MacBook",
    status: BotAccessRequestStatuses.OPEN,
    resolved_by: null,
    created_at: NOW,
    updated_at: NOW,
    status_changed_at: NOW,
    ...overrides,
  }
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [makeRow()]): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rows.length } as QueryResult
    }),
  }
}

const INSERT_PARAMS = {
  id: "bareq_1",
  workspaceId: "ws_1",
  botId: "bot_1",
  streamId: "stream_1",
  delegationId: "dlg_1",
  botName: "Kris's MacBook",
  delegationTitle: "Fix the build",
  requestedByLabel: "Kris's MacBook",
}

describe("BotAccessRequestRepository.insertOrGetOpen", () => {
  afterEach(() => mock.restore())

  it("inserts an open row with ON CONFLICT DO UPDATE on the partial unique index (always returns a row, INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ ...makeRow(), created: true }])

    const { request, created } = await BotAccessRequestRepository.insertOrGetOpen(db, INSERT_PARAMS)

    expect(captured.text).toContain("INSERT INTO bot_access_requests")
    expect(captured.text).toContain("ON CONFLICT (workspace_id, bot_id, stream_id) WHERE status = 'open'")
    expect(captured.text).toContain("DO UPDATE SET id = bot_access_requests.id")
    expect(captured.text).toContain("(xmax = 0) AS created")
    expect(captured.values).toContain(BotAccessRequestStatuses.OPEN)
    expect(created).toBe(true)
    expect(request).toMatchObject({ id: "bareq_1", workspaceId: "ws_1", botId: "bot_1", status: "open" })
  })

  it("returns the pre-existing open row (created=false) when the insert hit the conflict", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ ...makeRow(), created: false }])

    const { request, created } = await BotAccessRequestRepository.insertOrGetOpen(db, INSERT_PARAMS)

    expect(created).toBe(false)
    expect(request.id).toBe("bareq_1")
  })
})

describe("BotAccessRequestRepository.approve / deny CAS", () => {
  afterEach(() => mock.restore())

  it("approve CASes open → approved, guarded on status='open' (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [
      makeRow({ status: BotAccessRequestStatuses.APPROVED, resolved_by: "usr_kris" }),
    ])

    const result = await BotAccessRequestRepository.approve(db, {
      workspaceId: "ws_1",
      id: "bareq_1",
      resolvedBy: "usr_kris",
    })

    expect(captured.text).toContain("UPDATE bot_access_requests")
    // The CAS guard: only an open request is approvable.
    expect(captured.values).toContain(BotAccessRequestStatuses.OPEN)
    expect(captured.values).toContain(BotAccessRequestStatuses.APPROVED)
    expect(captured.values).toContain("usr_kris")
    expect(result?.status).toBe("approved")
  })

  it("approve returns null when the CAS matches nothing (already resolved)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    const result = await BotAccessRequestRepository.approve(db, {
      workspaceId: "ws_1",
      id: "bareq_1",
      resolvedBy: "usr_kris",
    })

    expect(result).toBeNull()
  })

  it("deny CASes open → denied and returns null on a lost race", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow({ status: BotAccessRequestStatuses.DENIED, resolved_by: "usr_kris" })])

    const denied = await BotAccessRequestRepository.deny(db, {
      workspaceId: "ws_1",
      id: "bareq_1",
      streamId: "stream_1",
      resolvedBy: "usr_kris",
    })
    expect(captured.values).toContain(BotAccessRequestStatuses.DENIED)
    expect(captured.values).toContain(BotAccessRequestStatuses.OPEN)
    expect(denied?.status).toBe("denied")

    const lost = createQuerier({ text: null, values: null }, [])
    expect(
      await BotAccessRequestRepository.deny(lost, { workspaceId: "ws_1", id: "bareq_1", resolvedBy: "usr_kris" })
    ).toBeNull()
  })
})
