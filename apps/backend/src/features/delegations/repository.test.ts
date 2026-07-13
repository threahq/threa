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
    claim_idempotency_key: null,
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
      claimIdempotencyKey: null,
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
      claimIdempotencyKey: null,
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

describe("DelegatedTaskRepository.reclaimByIdempotencyKey", () => {
  afterEach(() => mock.restore())

  it("re-keys a live claim guarded on the original idempotency key, restarting the lease", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow({ status: DelegationStatuses.CLAIMED })])

    await DelegatedTaskRepository.reclaimByIdempotencyKey(db, {
      workspaceId: "ws_1",
      id: "dlg_1",
      claimIdempotencyKey: "runner-key-1",
      claimTokenHash: "fresh_hash",
      ttlSeconds: 900,
    })

    expect(captured.values).toContain("runner-key-1")
    expect(captured.values).toContain("fresh_hash")
    expect(captured.values).toContain(DelegationStatuses.CLAIMED)
    expect(captured.values).toContain(DelegationStatuses.RUNNING)
    // Deliberately NO claim_expires_at guard: the recovery window includes a
    // lapsed-but-unswept claim; a swept (expired) row fails the status guard.
    expect(captured.text).not.toContain("claim_expires_at >")
  })

  it("returns null when the key doesn't match the live claim", async () => {
    const db = createQuerier({ text: null, values: null }, [])
    expect(
      await DelegatedTaskRepository.reclaimByIdempotencyKey(db, {
        workspaceId: "ws_1",
        id: "dlg_1",
        claimIdempotencyKey: "someone-elses-key",
        claimTokenHash: "x",
        ttlSeconds: 900,
      })
    ).toBeNull()
  })
})

describe("DelegatedTaskRepository.listOpen since", () => {
  afterEach(() => mock.restore())

  it("narrows to rows created after the instant when since is given", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])
    const since = new Date("2026-07-12T10:00:00.000Z")

    await DelegatedTaskRepository.listOpen(db, "ws_1", { since })

    expect(captured.text).toContain("created_at >")
    expect(captured.values).toContain(since)
  })
})

describe("DelegatedTaskRepository.findClaimedForUpdate", () => {
  afterEach(() => mock.restore())

  it("locks a live-claimed row FOR UPDATE under the same live-holder guard as the transitions", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow({ status: DelegationStatuses.RUNNING })])

    const row = await DelegatedTaskRepository.findClaimedForUpdate(db, {
      workspaceId: "ws_1",
      id: "dlg_1",
      claimTokenHash: "hash_1",
    })

    expect(captured.text).toContain("FOR UPDATE")
    expect(captured.text).toContain("claim_expires_at > NOW()")
    expect(captured.values).toContain(DelegationStatuses.CLAIMED)
    expect(captured.values).toContain(DelegationStatuses.RUNNING)
    expect(captured.values).toContain("hash_1")
    expect(row?.id).toBe("dlg_1")
  })

  it("returns null when no live claim matches (invalid or lapsed token)", async () => {
    const db = createQuerier({ text: null, values: null }, [])
    expect(
      await DelegatedTaskRepository.findClaimedForUpdate(db, { workspaceId: "ws_1", id: "dlg_1", claimTokenHash: "x" })
    ).toBeNull()
  })
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
    // Terminal transition: the stale progress note must not survive onto the card.
    expect(captured.text).toContain("status_note = NULL")
  })

  it("returns null when the row already reached a terminal state", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])
    expect(await DelegatedTaskRepository.markCancelled(db, { workspaceId: "ws_1", id: "dlg_1" })).toBeNull()
  })
})

describe("DelegatedTaskRepository.markDone", () => {
  afterEach(() => mock.restore())

  it("CASes any non-terminal status → completed with no token, clearing the note", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow({ status: DelegationStatuses.COMPLETED })])

    await DelegatedTaskRepository.markDone(db, { workspaceId: "ws_1", id: "dlg_1", streamId: "stream_1" })

    expect(captured.values).toContain(DelegationStatuses.COMPLETED)
    expect(captured.values).toContain(DelegationStatuses.OPEN)
    expect(captured.values).toContain(DelegationStatuses.CLAIMED)
    expect(captured.values).toContain(DelegationStatuses.RUNNING)
    expect(captured.values).toContain("stream_1")
    expect(captured.text).toContain("status_note = NULL")
    expect(captured.text).not.toContain("claim_token_hash =")
  })

  it("returns null when the row already reached a terminal state", async () => {
    const db = createQuerier({ text: null, values: null }, [])
    expect(await DelegatedTaskRepository.markDone(db, { workspaceId: "ws_1", id: "dlg_1" })).toBeNull()
  })
})

describe("DelegatedTaskRepository.listByStream", () => {
  afterEach(() => mock.restore())

  it("scopes to workspace + stream, orders newest first, and joins the created event id", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [
      { ...makeRow({ id: "dlg_2" }), created_event_id: "event_2" },
      { ...makeRow({ id: "dlg_1" }), created_event_id: null },
    ])

    const rows = await DelegatedTaskRepository.listByStream(db, "ws_1", "stream_1")

    expect(captured.text).toContain("dt.workspace_id = $1")
    expect(captured.text).toContain("dt.stream_id = $2")
    expect(captured.text).toContain("ORDER BY dt.created_at DESC")
    expect(captured.text).toContain("ce.event_type = 'delegation:created'")
    expect(captured.text).toContain("ce.payload->>'delegationId' = dt.id")
    expect(rows.map((d) => ({ id: d.id, createdEventId: d.createdEventId }))).toEqual([
      { id: "dlg_2", createdEventId: "event_2" },
      { id: "dlg_1", createdEventId: null },
    ])
  })
})

describe("DelegatedTaskRepository.findByIdWithEvent", () => {
  afterEach(() => mock.restore())

  it("scopes to id + workspace and joins the created event id", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ ...makeRow({ id: "dlg_1" }), created_event_id: "event_1" }])

    const row = await DelegatedTaskRepository.findByIdWithEvent(db, "ws_1", "dlg_1")

    expect(captured.text).toContain("dt.id = $1")
    expect(captured.text).toContain("dt.workspace_id = $2")
    expect(captured.text).toContain("ce.event_type = 'delegation:created'")
    expect(captured.text).toContain("ce.payload->>'delegationId' = dt.id")
    expect(captured.values).toEqual(["dlg_1", "ws_1"])
    expect(row).toMatchObject({ id: "dlg_1", createdEventId: "event_1" })
  })

  it("returns null when no row matches", async () => {
    const db = createQuerier({ text: null, values: null }, [])
    expect(await DelegatedTaskRepository.findByIdWithEvent(db, "ws_1", "dlg_missing")).toBeNull()
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
    expect(captured.text).toContain("status_note = NULL")
    expect(captured.values).toContain(DelegationStatuses.CLAIMED)
    expect(captured.values).toContain(DelegationStatuses.RUNNING)
    expect(expired.map((d) => d.id)).toEqual(["dlg_1", "dlg_2"])
  })
})
