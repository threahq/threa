import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { ScheduledMessageStatuses } from "@threahq/types"
import { ScheduledMessagesRepository } from "../../src/features/scheduled-messages/repository"
import { setupTestDatabase, withTestTransaction } from "./setup"

/**
 * Integration coverage for the bits of `ScheduledMessagesRepository` whose
 * correctness depends on PostgreSQL semantics that mocked-querier unit tests
 * can't validate. In particular this locks in the NULL-safe behavior of
 * PostgreSQL's `GREATEST` in `bumpEditFence` — `GREATEST(NULL, x)` returns
 * `x` in PostgreSQL (NULLs are ignored), unlike MySQL/Oracle where it would
 * propagate NULL. The unit test only inspects the SQL string, so a regression
 * (e.g. someone "helpfully" adding `COALESCE` and then accidentally swapping
 * the operands later, or migrating to a NULL-propagating fork) would be
 * invisible without an integration test that round-trips the actual UPDATE.
 */
describe("ScheduledMessagesRepository (integration)", () => {
  let pool: Pool
  const WORKSPACE_ID = "ws_test_smrepo"
  const USER_ID = "usr_test_smrepo"
  const STREAM_ID = "stream_test_smrepo"

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM scheduled_messages WHERE workspace_id = $1", [WORKSPACE_ID])
  })

  async function insertPendingRow(client: Parameters<Parameters<typeof withTestTransaction>[1]>[0], id: string) {
    return ScheduledMessagesRepository.insert(client, {
      id,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      streamId: STREAM_ID,
      parentMessageId: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "hi",
      attachmentIds: [],
      metadata: null,
      scheduledFor: new Date(Date.now() + 60 * 60_000),
      clientMessageId: null,
    })
  }

  describe("bumpEditFence", () => {
    test("sets edit_active_until from NULL on first acquisition (PostgreSQL GREATEST is NULL-safe)", async () => {
      await withTestTransaction(pool, async (client) => {
        const inserted = await insertPendingRow(client, "sched_smrepo_null")
        // Sanity: insert leaves the fence NULL — the default state every
        // worker fence starts in.
        expect(inserted.editActiveUntil).toBeNull()

        const before = Date.now()
        const bumped = await ScheduledMessagesRepository.bumpEditFence(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 600,
        })

        // The actual proof: PostgreSQL's GREATEST(NULL, NOW() + interval)
        // returns the interval, not NULL. If GREATEST propagated NULL (as
        // it does in MySQL/Oracle), the worker fence would never engage on
        // first edit and the worker could fire mid-edit.
        expect(bumped).not.toBeNull()
        expect(bumped!.editActiveUntil).not.toBeNull()
        const fenceMs = bumped!.editActiveUntil!.getTime()
        // Fence sits ~600s in the future, with generous slack for clock
        // and round-trip drift.
        expect(fenceMs).toBeGreaterThanOrEqual(before + 590_000)
        expect(fenceMs).toBeLessThanOrEqual(before + 610_000)
      })
    })

    test("monotonically advances on subsequent bumps with longer TTL", async () => {
      await withTestTransaction(pool, async (client) => {
        const inserted = await insertPendingRow(client, "sched_smrepo_advance")

        const first = await ScheduledMessagesRepository.bumpEditFence(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 60,
        })
        const second = await ScheduledMessagesRepository.bumpEditFence(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 600,
        })

        expect(first!.editActiveUntil).not.toBeNull()
        expect(second!.editActiveUntil).not.toBeNull()
        // Second bump's longer TTL pushes the fence further out.
        expect(second!.editActiveUntil!.getTime()).toBeGreaterThan(first!.editActiveUntil!.getTime())
      })
    })

    test("does not regress the fence when a shorter TTL is requested", async () => {
      await withTestTransaction(pool, async (client) => {
        const inserted = await insertPendingRow(client, "sched_smrepo_no_regress")

        const long = await ScheduledMessagesRepository.bumpEditFence(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 600,
        })
        const short = await ScheduledMessagesRepository.bumpEditFence(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 5,
        })

        // GREATEST keeps the longer fence. Without this, two devices editing
        // concurrently could pull each other's fences backwards as their
        // heartbeats interleave.
        expect(short!.editActiveUntil!.getTime()).toBe(long!.editActiveUntil!.getTime())
      })
    })

    test("does not bump the fence on rows that are no longer pending", async () => {
      await withTestTransaction(pool, async (client) => {
        const inserted = await insertPendingRow(client, "sched_smrepo_not_pending")

        // Manually flip status so we can verify the WHERE clause filters it out.
        // We can't go through the service here since that would require a
        // workspace + user + stream + queue row scaffold.
        await client.query(`UPDATE scheduled_messages SET status = $1 WHERE id = $2`, [
          ScheduledMessageStatuses.SENT,
          inserted.id,
        ])

        const bumped = await ScheduledMessagesRepository.bumpEditFence(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 600,
        })
        // The UPDATE matches zero rows — service treats this as "row moved
        // past pending" and surfaces SCHEDULED_MESSAGE_NOT_PENDING.
        expect(bumped).toBeNull()
      })
    })
  })

  /**
   * The bumpEditFence guarantee only matters if the worker's claim CAS
   * actually honors the fence it sets. These tests pin both halves of the
   * contract end-to-end: lock → bump → worker blocked → fence cleared →
   * worker proceeds. If a future refactor decouples them (e.g. moving the
   * fence check into application code where it could race the SQL), this
   * test will fail before the regression ships.
   */
  describe("bumpEditFence + tryStartSend interaction", () => {
    async function insertDuePendingRow(client: Parameters<Parameters<typeof withTestTransaction>[1]>[0], id: string) {
      // scheduled_for in the past so tryStartSend's `scheduled_for <= NOW()`
      // guard passes — otherwise the worker CAS would no-op for an unrelated
      // reason and we'd miss the fence-blocking signal we're trying to test.
      const row = await ScheduledMessagesRepository.insert(client, {
        id,
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        streamId: STREAM_ID,
        parentMessageId: null,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "hi",
        attachmentIds: [],
        metadata: null,
        scheduledFor: new Date(Date.now() - 1_000),
        clientMessageId: null,
      })
      return row
    }

    test("worker tryStartSend is blocked while the editor's fence is active, succeeds after the fence clears", async () => {
      await withTestTransaction(pool, async (client) => {
        const inserted = await insertDuePendingRow(client, "sched_smrepo_worker_blocked")
        expect(inserted.editActiveUntil).toBeNull()

        // Editor opens the dialog → fence pushed ~600s into the future.
        const bumped = await ScheduledMessagesRepository.bumpEditFence(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 600,
        })
        expect(bumped!.editActiveUntil).not.toBeNull()
        expect(bumped!.editActiveUntil!.getTime()).toBeGreaterThan(Date.now())

        // Worker tick: tryStartSend without bypassFence sees fence > NOW()
        // and refuses to claim. This is the actual "pause worker while
        // editing" guarantee the fence is supposed to provide.
        const blockedClaim = await ScheduledMessagesRepository.tryStartSend(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 10,
        })
        expect(blockedClaim).toBeNull()

        // Editor closes → fence cleared. tryStartSend now sees
        // edit_active_until IS NULL and proceeds.
        await ScheduledMessagesRepository.releaseEditFence(client, WORKSPACE_ID, inserted.id)
        const afterRelease = await ScheduledMessagesRepository.findById(client, WORKSPACE_ID, USER_ID, inserted.id)
        expect(afterRelease!.editActiveUntil).toBeNull()

        const claim = await ScheduledMessagesRepository.tryStartSend(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 10,
        })
        expect(claim).not.toBeNull()
        expect(claim!.status).toBe(ScheduledMessageStatuses.SENDING)
      })
    })

    test("user-initiated send (bypassFence=true) ignores the fence", async () => {
      await withTestTransaction(pool, async (client) => {
        const inserted = await insertDuePendingRow(client, "sched_smrepo_bypass")

        // Same editor session that holds the fence is the one calling
        // sendNow / past-time PATCH. Without bypassFence, the user's own
        // dialog lock would deadlock their own send.
        await ScheduledMessagesRepository.bumpEditFence(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 600,
        })

        const claim = await ScheduledMessagesRepository.tryStartSend(client, {
          workspaceId: WORKSPACE_ID,
          id: inserted.id,
          ttlSeconds: 10,
          bypassFence: true,
        })
        expect(claim).not.toBeNull()
        expect(claim!.status).toBe(ScheduledMessageStatuses.SENDING)
      })
    })
  })
})
