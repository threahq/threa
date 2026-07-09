import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { DelegationStatuses } from "@threa/types"
import { DelegatedTaskRepository } from "./repository"

const NOW = new Date("2026-07-09T12:00:00.000Z")

// A complete row so `mapRow` round-trips; SQL-capture tests assert on the
// queries the repo builds (house style — see enclave invocations-repository.test.ts).
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dlg_1",
    workspace_id: "ws_1",
    stream_id: "stream_1",
    session_id: "session_1",
    source_conversation_id: null,
    created_by_kind: "persona",
    created_by_id: "persona_system_ariadne",
    title: "Add rate limiting",
    brief: "Do the thing. Done when tests pass.",
    context_refs: ["memo:memo_1"],
    status: DelegationStatuses.OPEN,
    claim_token_hash: null,
    claim_expires_at: null,
    claimed_by_label: null,
    result_message_id: null,
    status_note: null,
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
  id: "dlg_1",
  workspaceId: "ws_1",
  streamId: "stream_1",
  sessionId: "session_1",
  sourceConversationId: null,
  createdByKind: "persona",
  createdById: "persona_system_ariadne",
  title: "Add rate limiting",
  brief: "Do the thing. Done when tests pass.",
  contextRefs: ["memo:memo_1"],
}

describe("DelegatedTaskRepository.insert", () => {
  afterEach(() => mock.restore())

  it("inserts an open row with contextRefs as JSON and maps it back camelCase", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    const row = await DelegatedTaskRepository.insert(db, INSERT_PARAMS)

    expect(captured.text).toContain("INSERT INTO delegated_tasks")
    expect(captured.values).toContain(DelegationStatuses.OPEN)
    expect(captured.values).toContain(JSON.stringify(["memo:memo_1"]))
    expect(row).toMatchObject({
      id: "dlg_1",
      workspaceId: "ws_1",
      status: DelegationStatuses.OPEN,
      contextRefs: ["memo:memo_1"],
    })
  })
})

describe("DelegatedTaskRepository.claim", () => {
  afterEach(() => mock.restore())

  it("CASes open → claimed, binding token hash + TTL (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow({ status: DelegationStatuses.CLAIMED })])

    await DelegatedTaskRepository.claim(db, {
      workspaceId: "ws_1",
      id: "dlg_1",
      claimTokenHash: "hash_1",
      claimedByLabel: "Kris's MacBook / Claude Code",
      ttlSeconds: 900,
    })

    expect(captured.text).toContain("UPDATE delegated_tasks")
    // The CAS guard: only an open row is claimable — a cancel that landed
    // first makes this match nothing.
    expect(captured.values).toContain(DelegationStatuses.OPEN)
    expect(captured.values).toContain("hash_1")
    expect(captured.values).toContain(900)
  })

  it("returns null when the CAS matches nothing (lost the claim-vs-cancel race)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    const result = await DelegatedTaskRepository.claim(db, {
      workspaceId: "ws_1",
      id: "dlg_1",
      claimTokenHash: "hash_1",
      claimedByLabel: "somewhere",
      ttlSeconds: 900,
    })

    expect(result).toBeNull()
  })
})

describe("claim-authenticated transitions carry the live-holder guard", () => {
  afterEach(() => mock.restore())

  const cases = [
    {
      name: "renewClaim",
      run: (db: Querier) =>
        DelegatedTaskRepository.renewClaim(db, {
          workspaceId: "ws_1",
          id: "dlg_1",
          claimTokenHash: "hash_1",
          ttlSeconds: 900,
        }),
    },
    {
      name: "markRunning",
      run: (db: Querier) =>
        DelegatedTaskRepository.markRunning(db, {
          workspaceId: "ws_1",
          id: "dlg_1",
          claimTokenHash: "hash_1",
          ttlSeconds: 900,
          statusNote: "half way",
        }),
    },
    {
      name: "complete",
      run: (db: Querier) =>
        DelegatedTaskRepository.complete(db, {
          workspaceId: "ws_1",
          id: "dlg_1",
          claimTokenHash: "hash_1",
          resultMessageId: "msg_result",
        }),
    },
    {
      name: "fail",
      run: (db: Querier) =>
        DelegatedTaskRepository.fail(db, {
          workspaceId: "ws_1",
          id: "dlg_1",
          claimTokenHash: "hash_1",
          statusNote: "build broke",
        }),
    },
  ]

  for (const { name, run } of cases) {
    it(`${name} guards on claimed|running + token hash + unexpired TTL`, async () => {
      const captured: Captured = { text: null, values: null }
      const db = createQuerier(captured, [makeRow({ status: DelegationStatuses.RUNNING })])

      await run(db)

      expect(captured.values).toContain(DelegationStatuses.CLAIMED)
      expect(captured.values).toContain(DelegationStatuses.RUNNING)
      expect(captured.values).toContain("hash_1")
      expect(captured.text).toContain("claim_expires_at > NOW()")
    })

    it(`${name} returns null when the guard matches nothing (lapsed or stolen claim)`, async () => {
      const captured: Captured = { text: null, values: null }
      const db = createQuerier(captured, [])
      expect(await run(db)).toBeNull()
    })
  }
})

describe("DelegatedTaskRepository.markCancelled", () => {
  afterEach(() => mock.restore())

  it("CASes any non-terminal status → cancelled, optionally stream-scoped", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow({ status: DelegationStatuses.CANCELLED })])

    await DelegatedTaskRepository.markCancelled(db, { workspaceId: "ws_1", id: "dlg_1", streamId: "stream_1" })

    expect(captured.values).toContain(DelegationStatuses.OPEN)
    expect(captured.values).toContain(DelegationStatuses.CLAIMED)
    expect(captured.values).toContain(DelegationStatuses.RUNNING)
    expect(captured.values).toContain("stream_1")
  })

  it("returns null when the row already reached a terminal state", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])
    expect(await DelegatedTaskRepository.markCancelled(db, { workspaceId: "ws_1", id: "dlg_1" })).toBeNull()
  })
})

describe("DelegatedTaskRepository.expireLapsedClaims", () => {
  afterEach(() => mock.restore())

  it("set-based CAS of every lapsed claim to expired (INV-56), returning the rows", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [
      makeRow({ id: "dlg_1", status: DelegationStatuses.EXPIRED }),
      makeRow({ id: "dlg_2", status: DelegationStatuses.EXPIRED }),
    ])

    const expired = await DelegatedTaskRepository.expireLapsedClaims(db)

    expect(captured.text).toContain("claim_expires_at <= NOW()")
    expect(captured.values).toContain(DelegationStatuses.CLAIMED)
    expect(captured.values).toContain(DelegationStatuses.RUNNING)
    expect(expired.map((d) => d.id)).toEqual(["dlg_1", "dlg_2"])
  })
})
