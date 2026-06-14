import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import { setupTestDatabase } from "./setup"
import { SyncLogRepository, type SyncLogEntryInput } from "../../src/features/sync"
import { permissionGroup } from "../../src/lib/outbox"

const MEMBERS_WRITE_GROUP = permissionGroup(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)

describe("SyncLogRepository catch-up reads", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function reserveOutboxIds(count: number): Promise<bigint[]> {
    const result = await pool.query<{ id: string }>(
      `SELECT nextval('outbox_id_seq') AS id FROM generate_series(1, $1)`,
      [count]
    )
    return result.rows.map((r) => BigInt(r.id))
  }

  function uniqueId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
  }

  async function addMembership(streamId: string, userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO stream_members (stream_id, member_id) VALUES ($1, $2) ON CONFLICT (stream_id, member_id) DO NOTHING`,
      [streamId, userId]
    )
  }

  /** Inserts a thread stream whose visibility inherits from `rootStreamId`. */
  async function addThread(workspaceId: string, threadId: string, rootStreamId: string, parentStreamId: string) {
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, parent_stream_id, root_stream_id, created_by)
       VALUES ($1, $2, 'thread', 'private', $3, $4, $5)`,
      [threadId, workspaceId, parentStreamId, rootStreamId, uniqueId("usr")]
    )
  }

  /** Inserts a top-level (root) channel stream with the given visibility. */
  async function addRootStream(workspaceId: string, streamId: string, visibility: "public" | "private") {
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, root_stream_id, created_by)
       VALUES ($1, $2, 'channel', $3, NULL, $4)`,
      [streamId, workspaceId, visibility, uniqueId("usr")]
    )
  }

  /** Appends one entry and returns its sync id. */
  async function appendEntry(workspaceId: string, entry: Omit<SyncLogEntryInput, "outboxEventId">): Promise<bigint> {
    const [outboxEventId] = await reserveOutboxIds(1)
    const assigned = await SyncLogRepository.appendForWorkspace(pool, workspaceId, [{ ...entry, outboxEventId }])
    return assigned.get(outboxEventId)!
  }

  function listFor(workspaceId: string, userId: string, after = 0n, limit = 100, permissionGroups: string[] = []) {
    return SyncLogRepository.listEntriesForUser(pool, { workspaceId, userId, permissionGroups, after, limit })
  }

  /**
   * Rewrites one workspace's entries to a past timestamp so the time-window
   * prune treats them as expired — scoping the otherwise-global prune to this
   * test's workspace (every other workspace's entries stay at NOW()).
   */
  async function backdateEntries(workspaceId: string, createdAt: Date): Promise<void> {
    await pool.query(`UPDATE sync_log SET created_at = $2 WHERE workspace_id = $1`, [workspaceId, createdAt])
  }

  test("filters entries to the requester's groups: workspace, own user, member streams", async () => {
    const workspaceId = uniqueId("ws")
    const alice = uniqueId("usr")
    const bob = uniqueId("usr")
    const aliceStream = uniqueId("stream")
    const bobStream = uniqueId("stream")
    await addMembership(aliceStream, alice)
    await addMembership(bobStream, bob)

    const workspaceWide = await appendEntry(workspaceId, {
      eventType: "stream:created",
      groups: ["workspace"],
      payload: { workspaceId, kind: "workspace-wide" },
    })
    const aliceOnly = await appendEntry(workspaceId, {
      eventType: "activity:created",
      groups: [`user:${alice}`],
      payload: { workspaceId, kind: "alice-only" },
    })
    const aliceStreamEntry = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${aliceStream}`],
      payload: { workspaceId, kind: "alice-stream" },
    })
    const bobStreamEntry = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${bobStream}`],
      payload: { workspaceId, kind: "bob-stream" },
    })

    const aliceEntries = await listFor(workspaceId, alice)
    expect(aliceEntries.map((e) => e.syncId)).toEqual([workspaceWide, aliceOnly, aliceStreamEntry])

    const bobEntries = await listFor(workspaceId, bob)
    expect(bobEntries.map((e) => e.syncId)).toEqual([workspaceWide, bobStreamEntry])
  })

  test("admits permission-group entries only for holders of the permission", async () => {
    const workspaceId = uniqueId("ws")
    const admin = uniqueId("usr")
    const member = uniqueId("usr")

    const invite = await appendEntry(workspaceId, {
      eventType: "invitation:sent",
      groups: [MEMBERS_WRITE_GROUP],
      payload: { workspaceId, invitationId: uniqueId("inv"), email: "invitee@example.com" },
    })

    // The admin holds members:write (passes its permission group); the member
    // does not, so the invitation entry never reaches them.
    const adminEntries = await listFor(workspaceId, admin, 0n, 100, [MEMBERS_WRITE_GROUP])
    expect(adminEntries.map((e) => e.syncId)).toEqual([invite])

    const memberEntries = await listFor(workspaceId, member, 0n, 100, [])
    expect(memberEntries.map((e) => e.syncId)).toEqual([])
  })

  test("bounds stream groups by the member_added join position — no pre-join history", async () => {
    const workspaceId = uniqueId("ws")
    const joiner = uniqueId("usr")
    const streamId = uniqueId("stream")

    // Pre-join history: appended before the join, must never surface.
    await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${streamId}`],
      payload: { workspaceId, kind: "pre-join" },
    })
    const joinEntry = await appendEntry(workspaceId, {
      eventType: "stream:member_added",
      groups: [`stream:${streamId}`, `user:${joiner}`],
      payload: { workspaceId, streamId, memberId: joiner },
    })
    await addMembership(streamId, joiner)
    const postJoin = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${streamId}`],
      payload: { workspaceId, kind: "post-join" },
    })

    const entries = await listFor(workspaceId, joiner)
    // Exactly the join entry (via the user group) and post-join content —
    // the exact-array compare proves the pre-join entry stays hidden
    // (windowed snapshots cover that history instead).
    expect(entries.map((e) => e.syncId)).toEqual([joinEntry, postJoin])
  })

  test("a membership predating the log (no member_added entry) is unbounded", async () => {
    const workspaceId = uniqueId("ws")
    const veteran = uniqueId("usr")
    const streamId = uniqueId("stream")
    await addMembership(streamId, veteran)

    const entry = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${streamId}`],
      payload: { workspaceId, kind: "any" },
    })

    const entries = await listFor(workspaceId, veteran)
    expect(entries.map((e) => e.syncId)).toEqual([entry])
  })

  // INV-62: threads inherit access from their root stream; a membership-only
  // filter would silently drop thread content for root-stream members.
  test("thread entries are visible to root-stream members who never joined the thread", async () => {
    const workspaceId = uniqueId("ws")
    const me = uniqueId("usr")
    const outsider = uniqueId("usr")
    const channel = uniqueId("stream")
    const thread = uniqueId("stream")
    await addMembership(channel, me)
    await addThread(workspaceId, thread, channel, channel)

    const threadMessage = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${thread}`],
      payload: { workspaceId, kind: "pierres-thread-reply" },
    })

    // Member of the root channel: sees the thread's content without being a
    // thread member (access inherits from the root, mirroring checkStreamAccess).
    const mine = await listFor(workspaceId, me)
    expect(mine.map((e) => e.syncId)).toEqual([threadMessage])

    // Not a member of the root: sees nothing.
    expect(await listFor(workspaceId, outsider)).toEqual([])
  })

  // INV-62: a public root channel grants read access to every workspace member
  // without a `stream_members` row, so catch-up must replay its events (and its
  // threads') for non-members — the recurring footgun a membership-only filter
  // hits. This mirrors streamAccessPredicateSql's public-root leg.
  test("public channel events reach a non-member; private channel events do not", async () => {
    const workspaceId = uniqueId("ws")
    const outsider = uniqueId("usr")
    const publicChannel = uniqueId("stream")
    const privateChannel = uniqueId("stream")
    const publicThread = uniqueId("stream")
    await addRootStream(workspaceId, publicChannel, "public")
    await addRootStream(workspaceId, privateChannel, "private")
    await addThread(workspaceId, publicThread, publicChannel, publicChannel)

    const publicMessage = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${publicChannel}`],
      payload: { workspaceId, kind: "public-channel" },
    })
    const publicThreadMessage = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${publicThread}`],
      payload: { workspaceId, kind: "public-thread" },
    })
    // Private channel content must stay hidden from a non-member even though a
    // `streams` row exists — the public leg must not over-match private roots.
    await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${privateChannel}`],
      payload: { workspaceId, kind: "private-channel" },
    })

    // The outsider joined nothing yet sees the public channel and its thread
    // (full history, no join bound), but never the private channel.
    const entries = await listFor(workspaceId, outsider)
    expect(entries.map((e) => e.syncId)).toEqual([publicMessage, publicThreadMessage])
  })

  test("a depth-2 thread inherits visibility from the root, not the immediate parent", async () => {
    const workspaceId = uniqueId("ws")
    const me = uniqueId("usr")
    const channel = uniqueId("stream")
    const thread = uniqueId("stream")
    const subThread = uniqueId("stream")
    await addMembership(channel, me)
    await addThread(workspaceId, thread, channel, channel)
    await addThread(workspaceId, subThread, channel, thread)

    const deepMessage = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${subThread}`],
      payload: { workspaceId, kind: "thread-of-thread" },
    })

    expect((await listFor(workspaceId, me)).map((e) => e.syncId)).toEqual([deepMessage])
  })

  test("inherited thread visibility is bounded by the root membership's join position", async () => {
    const workspaceId = uniqueId("ws")
    const joiner = uniqueId("usr")
    const channel = uniqueId("stream")
    const thread = uniqueId("stream")
    await addThread(workspaceId, thread, channel, channel)

    // Thread content from before the channel join, must never surface.
    await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${thread}`],
      payload: { workspaceId, kind: "thread-pre-join" },
    })
    const joinEntry = await appendEntry(workspaceId, {
      eventType: "stream:member_added",
      groups: [`stream:${channel}`, `user:${joiner}`],
      payload: { workspaceId, streamId: channel, memberId: joiner },
    })
    await addMembership(channel, joiner)
    const postJoinThreadMessage = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${thread}`],
      payload: { workspaceId, kind: "thread-post-join" },
    })

    const syncIds = (await listFor(workspaceId, joiner)).map((e) => e.syncId)
    expect(syncIds).toEqual([joinEntry, postJoinThreadMessage])
  })

  test("a rejoin moves the bound forward — entries from the left period stay hidden", async () => {
    const workspaceId = uniqueId("ws")
    const userId = uniqueId("usr")
    const streamId = uniqueId("stream")

    const firstJoin = await appendEntry(workspaceId, {
      eventType: "stream:member_added",
      groups: [`stream:${streamId}`, `user:${userId}`],
      payload: { workspaceId, streamId, memberId: userId },
    })
    // Posted while the user was gone — hidden behind the rejoin bound.
    await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${streamId}`],
      payload: { workspaceId, kind: "while-gone" },
    })
    const rejoin = await appendEntry(workspaceId, {
      eventType: "stream:member_added",
      groups: [`stream:${streamId}`, `user:${userId}`],
      payload: { workspaceId, streamId, memberId: userId },
    })
    await addMembership(streamId, userId)
    const afterRejoin = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${streamId}`],
      payload: { workspaceId, kind: "after-rejoin" },
    })

    // Both member_added entries reach the user via their user group (which
    // the join bound never gates); the while-gone stream entry stays hidden.
    const syncIds = (await listFor(workspaceId, userId)).map((e) => e.syncId)
    expect(syncIds).toEqual([firstJoin, rejoin, afterRejoin])
  })

  test("pages by cursor and respects the limit", async () => {
    const workspaceId = uniqueId("ws")
    const userId = uniqueId("usr")

    const ids: bigint[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        await appendEntry(workspaceId, {
          eventType: "stream:created",
          groups: ["workspace"],
          payload: { workspaceId, i },
        })
      )
    }

    const firstPage = await listFor(workspaceId, userId, 0n, 2)
    expect(firstPage.map((e) => e.syncId)).toEqual(ids.slice(0, 2))

    const secondPage = await listFor(workspaceId, userId, firstPage[1].syncId, 2)
    expect(secondPage.map((e) => e.syncId)).toEqual(ids.slice(2, 4))
  })

  test("head is the workspace's max sync id, 0 for an empty log; floor 0 before any prune", async () => {
    const workspaceId = uniqueId("ws")
    expect(await SyncLogRepository.getHeadAndRetainedFrom(pool, workspaceId)).toEqual({ head: 0n, retainedFrom: 0n })

    const last = await appendEntry(workspaceId, {
      eventType: "stream:created",
      groups: ["workspace"],
      payload: { workspaceId },
    })
    expect(await SyncLogRepository.getHeadAndRetainedFrom(pool, workspaceId)).toEqual({ head: last, retainedFrom: 0n })
  })

  test("entries are isolated per workspace", async () => {
    const workspaceA = uniqueId("ws")
    const workspaceB = uniqueId("ws")
    const userId = uniqueId("usr")

    await appendEntry(workspaceA, {
      eventType: "stream:created",
      groups: ["workspace"],
      payload: { workspaceId: workspaceA },
    })

    expect(await listFor(workspaceB, userId)).toEqual([])
  })

  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR

  test("prune deletes expired entries beyond the count floor and advances retained_from atomically", async () => {
    const workspaceId = uniqueId("ws")
    const userId = uniqueId("usr")
    const ids: bigint[] = []
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await appendEntry(workspaceId, {
          eventType: "stream:created",
          groups: ["workspace"],
          payload: { workspaceId, i },
        })
      )
    }
    // All five are old enough to expire; the count floor (keep last 2) is what
    // decides which survive.
    await backdateEntries(workspaceId, new Date(Date.now() - 60 * DAY))

    const { prunedThrough } = await SyncLogRepository.pruneExpiredEntries(pool, {
      cutoff: new Date(Date.now() - 30 * DAY),
      minKeep: 2,
      limit: 100,
    })

    // head = 5, head - minKeep = 3 ⇒ sync ids 1..3 pruned, 4..5 kept.
    expect(prunedThrough.get(workspaceId)).toBe(ids[2])
    expect(await SyncLogRepository.getHeadAndRetainedFrom(pool, workspaceId)).toEqual({
      head: ids[4],
      retainedFrom: ids[2],
    })
    // Catch-up from 0 now only sees the survivors above the floor.
    expect((await listFor(workspaceId, userId)).map((e) => e.syncId)).toEqual(ids.slice(3))
  })

  test("the count floor keeps every entry when history is at or below minKeep", async () => {
    const workspaceId = uniqueId("ws")
    await appendEntry(workspaceId, { eventType: "stream:created", groups: ["workspace"], payload: { workspaceId } })
    await appendEntry(workspaceId, { eventType: "stream:created", groups: ["workspace"], payload: { workspaceId } })
    await backdateEntries(workspaceId, new Date(Date.now() - 60 * DAY))

    const { prunedThrough } = await SyncLogRepository.pruneExpiredEntries(pool, {
      cutoff: new Date(Date.now() - 30 * DAY),
      minKeep: 2,
      limit: 100,
    })

    expect(prunedThrough.has(workspaceId)).toBe(false)
    expect((await SyncLogRepository.getHeadAndRetainedFrom(pool, workspaceId)).retainedFrom).toBe(0n)
  })

  test("the time horizon spares entries newer than the cutoff", async () => {
    const workspaceId = uniqueId("ws")
    const userId = uniqueId("usr")
    const ids: bigint[] = []
    for (let i = 0; i < 4; i += 1) {
      ids.push(
        await appendEntry(workspaceId, {
          eventType: "stream:created",
          groups: ["workspace"],
          payload: { workspaceId, i },
        })
      )
    }
    // Only the first two are aged past the cutoff; minKeep 0 takes the count
    // floor out of the picture, so the cutoff alone decides.
    await pool.query(`UPDATE sync_log SET created_at = $2 WHERE workspace_id = $1 AND sync_id <= $3`, [
      workspaceId,
      new Date(Date.now() - 60 * DAY),
      ids[1].toString(),
    ])

    const { prunedThrough } = await SyncLogRepository.pruneExpiredEntries(pool, {
      cutoff: new Date(Date.now() - 30 * DAY),
      minKeep: 0,
      limit: 100,
    })

    expect(prunedThrough.get(workspaceId)).toBe(ids[1])
    expect((await listFor(workspaceId, userId)).map((e) => e.syncId)).toEqual(ids.slice(2))
  })
})
