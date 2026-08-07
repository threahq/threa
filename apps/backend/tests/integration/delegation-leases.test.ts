import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { Pool } from "pg"
import { DelegationStatuses } from "@threa/types"
import { DelegatedTaskRepository, type DelegatedTask } from "../../src/features/delegations/repository"
import { setupIsolatedTestDatabase } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>

const holderFields = {
  claimTokenHash: null,
  claimIdempotencyKey: null,
  claimExpiresAt: null,
  claimedByLabel: null,
  statusNote: null,
}

async function seed(
  id: string,
  status: string,
  overrides: Record<string, unknown> = {},
  workspaceId = "ws_leases"
): Promise<DelegatedTask> {
  const fields = {
    claim_token_hash: null,
    claim_idempotency_key: null,
    claim_expires_at: null,
    claimed_by_label: null,
    status_note: null,
    ...overrides,
  }
  await pool.query(
    `INSERT INTO delegated_tasks
      (id, workspace_id, stream_id, created_by_kind, created_by_id, title, brief, status,
       claim_token_hash, claim_idempotency_key, claim_expires_at, claimed_by_label, status_note,
       created_at, updated_at, status_changed_at)
     VALUES ($1, $2, 'stream_leases', 'persona', 'persona_1', $1, 'brief', $3,
       $4, $5, $6, $7, $8, NOW() - interval '2 days', NOW() - interval '1 day', NOW() - interval '1 day')`,
    [
      id,
      workspaceId,
      status,
      fields.claim_token_hash,
      fields.claim_idempotency_key,
      fields.claim_expires_at,
      fields.claimed_by_label,
      fields.status_note,
    ]
  )
  return (await DelegatedTaskRepository.findById(pool, workspaceId, id))!
}

function claim(id: string, token = `${id}_token`, key: string | null = null, workspaceId = "ws_leases") {
  return DelegatedTaskRepository.claim(pool, {
    workspaceId,
    id,
    claimTokenHash: token,
    claimIdempotencyKey: key,
    claimedByLabel: "runner",
    ttlSeconds: 900,
  })
}

async function expectRow(id: string, expected: Partial<DelegatedTask>, workspaceId = "ws_leases") {
  expect(await DelegatedTaskRepository.findById(pool, workspaceId, id)).toMatchObject(expected)
}

async function raceTransactions<T, U>(
  left: (client: import("pg").PoolClient) => Promise<T>,
  right: (client: import("pg").PoolClient) => Promise<U>
): Promise<[T | null, U | null]> {
  const clients = await Promise.all([pool.connect(), pool.connect()])
  try {
    await Promise.all(clients.map((client) => client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")))
    const results = await Promise.allSettled([
      left(clients[0]).then(async (value) => (await clients[0].query("COMMIT"), value)),
      right(clients[1]).then(async (value) => (await clients[1].query("COMMIT"), value)),
    ])
    return results.map((result) => {
      if (result.status === "fulfilled") return result.value
      if (
        typeof result.reason === "object" &&
        result.reason !== null &&
        "code" in result.reason &&
        result.reason.code === "40001"
      ) {
        return null
      }
      throw result.reason
    }) as [T | null, U | null]
  } finally {
    await Promise.allSettled(clients.map((client) => client.query("ROLLBACK")))
    clients.forEach((client) => client.release())
  }
}

beforeAll(async () => ({ pool, cleanup } = await setupIsolatedTestDatabase("delegation_leases")), 120_000)
afterAll(async () => cleanup(), 120_000)

describe("delegation lease recovery SQL", () => {
  it("sweeps lapsed claimed and running rows only, clearing holder fields and advancing DB timestamps", async () => {
    const claimedBefore = await seed("dlg_sweep_claimed", "claimed", {
      claim_token_hash: "a",
      claim_idempotency_key: "key-a",
      claim_expires_at: new Date(0),
      claimed_by_label: "a",
      status_note: "working",
    })
    const runningBefore = await seed("dlg_sweep_running", "running", {
      claim_token_hash: "b",
      claim_idempotency_key: "key-b",
      claim_expires_at: new Date(0),
      claimed_by_label: "b",
      status_note: "working",
    })
    await seed("dlg_sweep_live", "claimed", { claim_token_hash: "live", claim_expires_at: new Date("2099-01-01") })
    await seed("dlg_sweep_expired", "expired", { claim_token_hash: "historical" })
    await seed("dlg_sweep_open", "open")
    await seed(
      "dlg_sweep_other",
      "claimed",
      {
        claim_token_hash: "other",
        claim_idempotency_key: "key-other",
        claim_expires_at: new Date(0),
        claimed_by_label: "other-runner",
        status_note: "working",
      },
      "ws_other"
    )

    const reopened = await DelegatedTaskRepository.reopenLapsedClaims(pool)
    const changed = reopened.filter((row) => row.id.startsWith("dlg_sweep_"))
    expect(changed.map((row) => row.id).sort()).toEqual(["dlg_sweep_claimed", "dlg_sweep_other", "dlg_sweep_running"])
    expect(
      changed.map((row) => ({
        workspaceId: row.workspaceId,
        status: row.status,
        claimTokenHash: row.claimTokenHash,
        claimIdempotencyKey: row.claimIdempotencyKey,
        claimExpiresAt: row.claimExpiresAt,
        claimedByLabel: row.claimedByLabel,
        statusNote: row.statusNote,
      }))
    ).toEqual([
      { workspaceId: "ws_leases", status: "open", ...holderFields },
      { workspaceId: "ws_leases", status: "open", ...holderFields },
      { workspaceId: "ws_other", status: "open", ...holderFields },
    ])
    expect(changed.find((row) => row.id === claimedBefore.id)!.statusChangedAt.getTime()).toBeGreaterThan(
      claimedBefore.statusChangedAt.getTime()
    )
    expect(changed.find((row) => row.id === runningBefore.id)!.statusChangedAt.getTime()).toBeGreaterThan(
      runningBefore.statusChangedAt.getTime()
    )
    await expectRow("dlg_sweep_live", { status: "claimed", claimTokenHash: "live" })
    await expectRow("dlg_sweep_expired", { status: "expired", claimTokenHash: "historical" })
    await expectRow("dlg_sweep_open", { status: "open" })
    await expectRow("dlg_sweep_other", { status: "open" }, "ws_other")
  })

  it("releases claimed and running live holders, but rejects lapsed, mismatched, and cross-workspace holders", async () => {
    for (const status of ["claimed", "running"]) {
      const id = `dlg_release_${status}`
      await seed(id, status, {
        claim_token_hash: "token",
        claim_idempotency_key: "key",
        claim_expires_at: new Date("2099-01-01"),
        claimed_by_label: "runner",
        status_note: "work",
      })
      expect(
        await DelegatedTaskRepository.release(pool, { workspaceId: "ws_leases", id, claimTokenHash: "token" })
      ).toMatchObject({ status: "open", ...holderFields })
    }
    await seed("dlg_release_lapsed", "claimed", { claim_token_hash: "token", claim_expires_at: new Date(0) })
    await seed("dlg_release_mismatch", "running", {
      claim_token_hash: "token",
      claim_expires_at: new Date("2099-01-01"),
    })
    expect(
      await DelegatedTaskRepository.release(pool, {
        workspaceId: "ws_leases",
        id: "dlg_release_lapsed",
        claimTokenHash: "token",
      })
    ).toBeNull()
    expect(
      await DelegatedTaskRepository.release(pool, {
        workspaceId: "ws_leases",
        id: "dlg_release_mismatch",
        claimTokenHash: "wrong",
      })
    ).toBeNull()
    expect(
      await DelegatedTaskRepository.release(pool, {
        workspaceId: "ws_other",
        id: "dlg_release_mismatch",
        claimTokenHash: "token",
      })
    ).toBeNull()
  })

  it("direct claim accepts open and expired but rejects settled and currently held rows", async () => {
    for (const status of ["open", "expired"]) {
      const id = `dlg_claim_yes_${status}`
      await seed(id, status, { status_note: "stale" })
      expect(await claim(id)).toMatchObject({ status: "claimed", statusNote: null })
    }
    for (const status of ["completed", "failed", "cancelled", "claimed", "running"]) {
      const id = `dlg_claim_no_${status}`
      await seed(
        id,
        status,
        status === "claimed" || status === "running"
          ? { claim_token_hash: "held", claim_expires_at: new Date("2099-01-01") }
          : {}
      )
      expect(await claim(id)).toBeNull()
    }
    await seed("dlg_claim_other", "open", {}, "ws_other")
    expect(await claim("dlg_claim_other")).toBeNull()
  })

  it("mark done and cancel accept historical expired rows", async () => {
    await seed("dlg_expired_done", "expired")
    await seed("dlg_expired_cancel", "expired")
    expect(
      await DelegatedTaskRepository.markDone(pool, { workspaceId: "ws_leases", id: "dlg_expired_done" })
    ).toMatchObject({ status: "completed" })
    expect(
      await DelegatedTaskRepository.markCancelled(pool, { workspaceId: "ws_leases", id: "dlg_expired_cancel" })
    ).toMatchObject({ status: "cancelled" })
  })

  it("since includes reopened old work and excludes unchanged old open work", async () => {
    await seed("dlg_since_reopened", "running", { claim_token_hash: "old", claim_expires_at: new Date(0) })
    await seed("dlg_since_unchanged", "open")
    const cursor = (await pool.query<{ now: Date }>("SELECT NOW() AS now")).rows[0].now
    await DelegatedTaskRepository.reopenLapsedClaims(pool)
    const delta = await DelegatedTaskRepository.listOpen(pool, "ws_leases", { since: cursor })
    expect(delta.map((row) => row.id)).toContain("dlg_since_reopened")
    expect(delta.map((row) => row.id)).not.toContain("dlg_since_unchanged")
  })

  it("does not re-key a lapsed claim; after sweep the same key can claim and a competing claimant loses", async () => {
    await seed("dlg_rekey", "claimed", {
      claim_token_hash: "old",
      claim_idempotency_key: "runner-key",
      claim_expires_at: new Date(0),
    })
    expect(
      await DelegatedTaskRepository.reclaimByIdempotencyKey(pool, {
        workspaceId: "ws_leases",
        id: "dlg_rekey",
        claimIdempotencyKey: "runner-key",
        claimTokenHash: "new",
        ttlSeconds: 900,
      })
    ).toBeNull()
    await DelegatedTaskRepository.reopenLapsedClaims(pool)
    const [sameKey, competitor] = await Promise.all([
      claim("dlg_rekey", "same-key-token", "runner-key"),
      claim("dlg_rekey", "competitor"),
    ])
    expect([sameKey, competitor].filter(Boolean)).toHaveLength(1)
    const winner = sameKey ?? competitor!
    await expectRow("dlg_rekey", { status: "claimed", claimTokenHash: winner.claimTokenHash })
  })

  it("allows only the sweep when a lapsed claim races a heartbeat", async () => {
    await seed("dlg_lapsed_heartbeat", "claimed", { claim_token_hash: "token", claim_expires_at: new Date(0) })
    const [swept, heartbeat] = await raceTransactions(
      (client) => DelegatedTaskRepository.reopenLapsedClaims(client),
      (client) =>
        DelegatedTaskRepository.renewClaim(client, {
          workspaceId: "ws_leases",
          id: "dlg_lapsed_heartbeat",
          claimTokenHash: "token",
          ttlSeconds: 900,
        })
    )
    expect(swept?.some((row) => row.id === "dlg_lapsed_heartbeat")).toBe(true)
    expect(heartbeat).toBeNull()
    await expectRow("dlg_lapsed_heartbeat", { status: "open", ...holderFields })
  })

  it("allows only the heartbeat when a live claim races a sweep", async () => {
    await seed("dlg_live_heartbeat", "claimed", {
      claim_token_hash: "token",
      claim_expires_at: new Date("2099-01-01"),
    })
    const [swept, heartbeat] = await raceTransactions(
      (client) => DelegatedTaskRepository.reopenLapsedClaims(client),
      (client) =>
        DelegatedTaskRepository.renewClaim(client, {
          workspaceId: "ws_leases",
          id: "dlg_live_heartbeat",
          claimTokenHash: "token",
          ttlSeconds: 900,
        })
    )
    expect(swept?.some((row) => row.id === "dlg_live_heartbeat") ?? false).toBe(false)
    expect(heartbeat).toMatchObject({ status: "claimed", claimTokenHash: "token" })
    await expectRow("dlg_live_heartbeat", {
      status: "claimed",
      claimTokenHash: "token",
      claimExpiresAt: heartbeat!.claimExpiresAt,
    })
  })

  it("allows exactly one release or competing terminal transition", async () => {
    const competitors = [
      [
        "complete",
        (id: string, db: import("pg").PoolClient) =>
          DelegatedTaskRepository.complete(db, {
            workspaceId: "ws_leases",
            id,
            claimTokenHash: "token",
            resultMessageId: null,
          }),
      ],
      [
        "fail",
        (id: string, db: import("pg").PoolClient) =>
          DelegatedTaskRepository.fail(db, {
            workspaceId: "ws_leases",
            id,
            claimTokenHash: "token",
            statusNote: "failed",
          }),
      ],
      [
        "cancel",
        (id: string, db: import("pg").PoolClient) =>
          DelegatedTaskRepository.markCancelled(db, { workspaceId: "ws_leases", id }),
      ],
    ] as const
    for (const [name, transition] of competitors) {
      const id = `dlg_release_race_${name}`
      await seed(id, "running", { claim_token_hash: "token", claim_expires_at: new Date("2099-01-01") })
      const [released, settled] = await raceTransactions(
        (client) => DelegatedTaskRepository.release(client, { workspaceId: "ws_leases", id, claimTokenHash: "token" }),
        (client) => transition(id, client)
      )
      expect([released, settled].filter(Boolean)).toHaveLength(1)
      await expectRow(id, { status: released ? "open" : settled!.status })
    }

    await seed("dlg_release_race_sweep", "running", { claim_token_hash: "token", claim_expires_at: new Date(0) })
    const [released, swept] = await Promise.all([
      DelegatedTaskRepository.release(pool, {
        workspaceId: "ws_leases",
        id: "dlg_release_race_sweep",
        claimTokenHash: "token",
      }),
      DelegatedTaskRepository.reopenLapsedClaims(pool),
    ])
    expect(Number(released !== null) + Number(swept.some((row) => row.id === "dlg_release_race_sweep"))).toBe(1)
    await expectRow("dlg_release_race_sweep", { status: "open", ...holderFields })
  })

  it("serializes requeue against direct claim", async () => {
    await seed("dlg_requeue_claim_race", "expired", { status_note: "stale" })
    const [requeued, claimed] = await raceTransactions(
      (client) => DelegatedTaskRepository.requeue(client, { workspaceId: "ws_leases", id: "dlg_requeue_claim_race" }),
      (client) =>
        DelegatedTaskRepository.claim(client, {
          workspaceId: "ws_leases",
          id: "dlg_requeue_claim_race",
          claimTokenHash: "new-owner",
          claimIdempotencyKey: null,
          claimedByLabel: "runner",
          ttlSeconds: 900,
        })
    )
    expect([requeued, claimed].filter(Boolean)).toHaveLength(1)
    await expectRow(
      "dlg_requeue_claim_race",
      requeued ? { status: "open", ...holderFields } : { status: "claimed", claimTokenHash: "new-owner" }
    )
  })

  it("rejects every old-token operation after replacement claim", async () => {
    await seed("dlg_old_token", "claimed", { claim_token_hash: "old", claim_expires_at: new Date("2099-01-01") })
    expect(
      await DelegatedTaskRepository.release(pool, {
        workspaceId: "ws_leases",
        id: "dlg_old_token",
        claimTokenHash: "old",
      })
    ).toMatchObject({ status: "open" })
    expect(await claim("dlg_old_token", "replacement")).toMatchObject({ status: "claimed" })
    const results = await Promise.all([
      DelegatedTaskRepository.renewClaim(pool, {
        workspaceId: "ws_leases",
        id: "dlg_old_token",
        claimTokenHash: "old",
        ttlSeconds: 900,
      }),
      DelegatedTaskRepository.release(pool, { workspaceId: "ws_leases", id: "dlg_old_token", claimTokenHash: "old" }),
      DelegatedTaskRepository.complete(pool, {
        workspaceId: "ws_leases",
        id: "dlg_old_token",
        claimTokenHash: "old",
        resultMessageId: null,
      }),
      DelegatedTaskRepository.fail(pool, {
        workspaceId: "ws_leases",
        id: "dlg_old_token",
        claimTokenHash: "old",
        statusNote: "old",
      }),
    ])
    expect(results).toEqual([null, null, null, null])
    await expectRow("dlg_old_token", { status: "claimed", claimTokenHash: "replacement" })
  })
})
