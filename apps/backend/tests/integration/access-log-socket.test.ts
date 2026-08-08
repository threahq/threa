/**
 * Socket capture integration (step 3): subscribe/unsubscribe rows on room
 * join/leave/disconnect, denial capture, and delivered-set reconstruction.
 * Boots the real server (setup.ts preload) and reads rows back from threa_test.
 * Socket audit rows are fire-and-forget, so assertions poll for the row to land.
 *
 * Run: bun test --preload ./tests/setup.ts tests/integration/access-log-socket.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { io, Socket } from "socket.io-client"
import { Pool } from "pg"
import { getTestDatabaseTarget } from "../test-database"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createChannel,
  createScratchpad,
  sendMessage,
  getUserId,
  joinRoom,
} from "../client"
import { AccessLogRepository } from "../../src/features/access-log"

function getBaseUrl(): string {
  return process.env.TEST_BASE_URL || "http://localhost:3001"
}

interface SubjectRef {
  type: string
  id?: string
}

interface AccessLogDbRow {
  workspace_id: string | null
  actor_type: string
  actor_id: string
  auth_ref: string | null
  operation: string
  access_kind: string
  outcome: string
  subjects: SubjectRef[] | null
}

function cookieHeader(client: TestClient): string {
  const cookies = (client as unknown as { cookies?: Map<string, string> }).cookies
  if (!cookies) return ""
  return Array.from(cookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")
}

function createSocket(client: TestClient): Socket {
  return io(getBaseUrl(), {
    extraHeaders: { Cookie: cookieHeader(client) },
    transports: ["websocket"],
    autoConnect: false,
  })
}

function connectSocket(socket: Socket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket connection timeout")), timeoutMs)
    socket.on("connect", () => {
      clearTimeout(timeout)
      resolve()
    })
    socket.on("connect_error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    socket.connect()
  })
}

const testRunId = Math.random().toString(36).slice(2, 8)
const email = (name: string) => `${name}-${testRunId}@test.com`

function hasStreamSubject(row: AccessLogDbRow, streamId: string): boolean {
  return (row.subjects ?? []).some((s) => s.type === "stream" && s.id === streamId)
}

describe("access-log socket capture", () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function pollRows(
    where: string,
    params: unknown[],
    predicate: (rows: AccessLogDbRow[]) => boolean = (rows) => rows.length > 0
  ): Promise<AccessLogDbRow[]> {
    // Generous window: successful joins coalesce for DEFAULT_SUBSCRIBE_COALESCE_MS
    // (2s) before their batch row lands, on top of fire-and-forget insert lag.
    for (let attempt = 0; attempt < 120; attempt++) {
      const { rows } = await pool.query<AccessLogDbRow>(
        `SELECT workspace_id, actor_type, actor_id, auth_ref, operation, access_kind, outcome, subjects
         FROM access_log WHERE ${where} ORDER BY occurred_at DESC`,
        params
      )
      if (predicate(rows)) return rows
      await new Promise((r) => setTimeout(r, 50))
    }
    return []
  }

  test("stream-room join records a subscribe row: sconn auth_ref, stream subject, usr_ actor", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("sub"), "Subscriber")
    const ws = await createWorkspace(client, "Sub WS")
    const stream = await createChannel(client, ws.id, `sub-${testRunId}`, "private")
    const userId = await getUserId(client, ws.id, user.id)

    const socket = createSocket(client)
    await connectSocket(socket)
    await joinRoom(socket, `ws:${ws.id}:stream:${stream.id}`)

    const rows = await pollRows(
      "workspace_id = $1 AND operation = 'socket.subscribe' AND access_kind = 'subscribe' AND actor_id = $2 AND outcome = 'success'",
      [ws.id, userId],
      (rs) => rs.some((r) => hasStreamSubject(r, stream.id))
    )
    const row = rows.find((r) => hasStreamSubject(r, stream.id))
    expect(row).toBeDefined()
    expect(row).toMatchObject({
      workspace_id: ws.id,
      actor_type: "user",
      actor_id: userId,
      operation: "socket.subscribe",
      access_kind: "subscribe",
      outcome: "success",
    })
    expect(row!.auth_ref?.startsWith("sconn_")).toBe(true)

    socket.disconnect()
  })

  test("leaving a stream room records an unsubscribe row with the same sconn + subject", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("leave"), "Leaver")
    const ws = await createWorkspace(client, "Leave WS")
    const stream = await createChannel(client, ws.id, `leave-${testRunId}`, "private")
    const userId = await getUserId(client, ws.id, user.id)
    const room = `ws:${ws.id}:stream:${stream.id}`

    const socket = createSocket(client)
    await connectSocket(socket)
    await joinRoom(socket, room)

    const subRows = await pollRows("operation = 'socket.subscribe' AND actor_id = $1", [userId], (rs) =>
      rs.some((r) => hasStreamSubject(r, stream.id))
    )
    const sconn = subRows.find((r) => hasStreamSubject(r, stream.id))!.auth_ref
    expect(sconn?.startsWith("sconn_")).toBe(true)

    socket.emit("leave", room)

    const unsubRows = await pollRows(
      "operation = 'socket.unsubscribe' AND actor_id = $1 AND auth_ref = $2",
      [userId, sconn],
      (rs) => rs.some((r) => hasStreamSubject(r, stream.id))
    )
    const unsub = unsubRows.find((r) => hasStreamSubject(r, stream.id))
    expect(unsub).toBeDefined()
    expect(unsub).toMatchObject({
      actor_id: userId,
      access_kind: "unsubscribe",
      outcome: "success",
      auth_ref: sconn,
    })

    socket.disconnect()
  })

  test("disconnect records unsubscribe rows for still-joined rooms", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("disc"), "Disconnector")
    const ws = await createWorkspace(client, "Disc WS")
    const stream = await createChannel(client, ws.id, `disc-${testRunId}`, "private")
    const userId = await getUserId(client, ws.id, user.id)

    const socket = createSocket(client)
    await connectSocket(socket)
    await joinRoom(socket, `ws:${ws.id}`)
    await joinRoom(socket, `ws:${ws.id}:stream:${stream.id}`)

    const subRows = await pollRows("operation = 'socket.subscribe' AND actor_id = $1", [userId], (rs) =>
      rs.some((r) => hasStreamSubject(r, stream.id))
    )
    const sconn = subRows.find((r) => hasStreamSubject(r, stream.id))!.auth_ref

    socket.disconnect()

    // ONE coalesced unsubscribe closes every room this connection held —
    // workspace + stream subjects union into a single batch row.
    const unsubRows = await pollRows("operation = 'socket.unsubscribe' AND auth_ref = $1", [sconn])
    expect(unsubRows).toHaveLength(1)
    expect(hasStreamSubject(unsubRows[0], stream.id)).toBe(true)
    expect((unsubRows[0].subjects ?? []).some((s) => s.type === "workspace" && s.id === ws.id)).toBe(true)
  })

  test("bulk join coalesces into one subjects-array subscribe row per connection", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("bulk"), "Bulk Joiner")
    const ws = await createWorkspace(client, "Bulk WS")
    const streamA = await createChannel(client, ws.id, `bulk-a-${testRunId}`, "private")
    const streamB = await createChannel(client, ws.id, `bulk-b-${testRunId}`, "private")
    const userId = await getUserId(client, ws.id, user.id)

    const socket = createSocket(client)
    await connectSocket(socket)
    // The connect-time pattern: workspace room + the sidebar's stream rooms,
    // all inside one coalescing window.
    await joinRoom(socket, `ws:${ws.id}`)
    await joinRoom(socket, `ws:${ws.id}:stream:${streamA.id}`)
    await joinRoom(socket, `ws:${ws.id}:stream:${streamB.id}`)
    socket.disconnect()

    const subRows = await pollRows(
      "workspace_id = $1 AND operation = 'socket.subscribe' AND actor_id = $2 AND outcome = 'success'",
      [ws.id, userId],
      (rs) => rs.some((r) => hasStreamSubject(r, streamA.id))
    )
    // One batch row carries all three subjects — not three rows.
    expect(subRows).toHaveLength(1)
    const subjects = subRows[0].subjects ?? []
    expect(subjects).toHaveLength(3)
    expect(subjects.some((s) => s.type === "workspace" && s.id === ws.id)).toBe(true)
    expect(hasStreamSubject(subRows[0], streamA.id)).toBe(true)
    expect(hasStreamSubject(subRows[0], streamB.id)).toBe(true)
  })

  test("reconstructDeliveredEvents pairs v1 per-room rows (pre-coalescing backward compat)", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("v1compat"), "V1 Compat")
    const ws = await createWorkspace(client, "V1 WS")
    const stream = await createChannel(client, ws.id, `v1-${testRunId}`, "private")
    const userId = await getUserId(client, ws.id, user.id)
    await sendMessage(client, ws.id, stream.id, "inside v1 interval")

    // Hand-inserted rows in the pre-coalescing shape: single-subject subscribe
    // and unsubscribe bracketing now. The CTE must keep pairing these — 13
    // months of production rows have this shape.
    const authRef = `sconn_v1compat${testRunId}`
    const subject = JSON.stringify([{ type: "stream", id: stream.id }])
    await pool.query(
      `INSERT INTO access_log (id, workspace_id, occurred_at, actor_type, actor_id, auth_ref, operation, access_kind, outcome, subjects)
       VALUES ($5, $1, now() - interval '1 hour', 'user', $2, $3, 'socket.subscribe', 'subscribe', 'success', $4::jsonb),
              ($6, $1, now() + interval '1 minute', 'user', $2, $3, 'socket.unsubscribe', 'unsubscribe', 'success', $4::jsonb)`,
      [ws.id, userId, authRef, subject, `alog_v1s${testRunId}`, `alog_v1u${testRunId}`]
    )

    const delivered = await AccessLogRepository.reconstructDeliveredEvents(pool, {
      workspaceId: ws.id,
      streamId: stream.id,
      from: new Date(Date.now() - 60 * 60 * 1000),
      to: new Date(),
    })
    const forV1Conn = delivered.filter((d) => d.authRef === authRef)
    expect(forV1Conn.length).toBeGreaterThanOrEqual(1)
    expect(forV1Conn.some((d) => d.eventType === "message_created")).toBe(true)
  })

  test("denied join (stream in another workspace) records a denied subscribe row", async () => {
    const clientA = new TestClient()
    const userA = await loginAs(clientA, email("owner"), "Owner A")
    const wsA = await createWorkspace(clientA, "Owner A WS")
    const privateStream = await createScratchpad(clientA, wsA.id)

    const clientB = new TestClient()
    const userB = await loginAs(clientB, email("intruder"), "Intruder B")
    const wsB = await createWorkspace(clientB, "Intruder B WS")
    const userBId = await getUserId(clientB, wsB.id, userB.id)

    const socket = createSocket(clientB)
    await connectSocket(socket)
    // B tries to join A's private stream under B's own workspace id → the
    // handler resolves B in wsB, then validateStreamAccess 404s (stream not in
    // wsB) → a denied subscribe row with the attempted stream subject.
    await joinRoom(socket, `ws:${wsB.id}:stream:${privateStream.id}`).catch(() => {})

    const rows = await pollRows(
      "operation = 'socket.subscribe' AND access_kind = 'subscribe' AND outcome = 'denied' AND actor_id = $1",
      [userBId],
      (rs) => rs.some((r) => hasStreamSubject(r, privateStream.id))
    )
    const denied = rows.find((r) => hasStreamSubject(r, privateStream.id))
    expect(denied).toBeDefined()
    expect(denied).toMatchObject({
      workspace_id: wsB.id,
      actor_type: "user",
      actor_id: userBId,
      access_kind: "subscribe",
      outcome: "denied",
    })
    expect(denied!.auth_ref?.startsWith("sconn_")).toBe(true)

    void userA
    socket.disconnect()
  })

  test("joining a workspace room you are not a member of records a denied subscribe row", async () => {
    const clientA = new TestClient()
    await loginAs(clientA, email("member-a"), "Member A")
    const wsA = await createWorkspace(clientA, "Member A WS")

    const clientB = new TestClient()
    const userB = await loginAs(clientB, email("nonmember"), "Non Member")
    await createWorkspace(clientB, "Non Member WS")

    const socket = createSocket(clientB)
    await connectSocket(socket)
    // B is authenticated but not a member of wsA → the workspace-room join is a
    // cross-workspace probe. Actor is B's WorkOS user id (no wsA user resolves).
    await joinRoom(socket, `ws:${wsA.id}`).catch(() => {})

    const rows = await pollRows(
      "workspace_id = $1 AND operation = 'socket.subscribe' AND outcome = 'denied' AND actor_id = $2",
      [wsA.id, userB.id],
      (rs) => rs.some((r) => (r.subjects ?? []).some((s) => s.type === "workspace" && s.id === wsA.id))
    )
    const denied = rows.find((r) => (r.subjects ?? []).some((s) => s.type === "workspace" && s.id === wsA.id))
    expect(denied).toBeDefined()
    expect(denied).toMatchObject({
      actor_type: "user",
      actor_id: userB.id,
      access_kind: "subscribe",
      outcome: "denied",
    })
    expect(denied!.auth_ref?.startsWith("sconn_")).toBe(true)

    socket.disconnect()
  })

  test("reconstructDeliveredEvents returns exactly the in-interval events for the subscriber", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("recon"), "Reconstructor")
    const ws = await createWorkspace(client, "Recon WS")
    const stream = await createChannel(client, ws.id, `recon-${testRunId}`, "private")
    const userId = await getUserId(client, ws.id, user.id)
    const room = `ws:${ws.id}:stream:${stream.id}`

    const socket = createSocket(client)
    await connectSocket(socket)
    await joinRoom(socket, room)

    // Wait for the subscribe row so its occurred_at precedes the in-window
    // messages (record() is fire-and-forget after the join ack).
    await pollRows("operation = 'socket.subscribe' AND actor_id = $1", [userId], (rs) =>
      rs.some((r) => hasStreamSubject(r, stream.id))
    )

    const inWindow = 3
    for (let i = 0; i < inWindow; i++) {
      await sendMessage(client, ws.id, stream.id, `in-window ${i}`)
    }

    socket.emit("leave", room)
    // Wait for the unsubscribe row to close the interval before sending the
    // out-of-window messages, so their created_at is strictly after it.
    await pollRows("operation = 'socket.unsubscribe' AND actor_id = $1", [userId], (rs) =>
      rs.some((r) => hasStreamSubject(r, stream.id))
    )

    for (let i = 0; i < 2; i++) {
      await sendMessage(client, ws.id, stream.id, `out-of-window ${i}`)
    }
    socket.disconnect()

    const delivered = await AccessLogRepository.reconstructDeliveredEvents(pool, {
      // Pad disabled: these tests assert exact interval semantics; the skew pad
      // has its own dedicated test below.
      clockSkewToleranceMs: 0,
      workspaceId: ws.id,
      streamId: stream.id,
      from: new Date(0),
      to: new Date(Date.now() + 60_000),
    })

    const messageEvents = delivered.filter((e) => e.eventType === "message_created")
    expect(messageEvents.length).toBe(inWindow)
    expect(messageEvents.every((e) => e.actorId === userId)).toBe(true)
    expect(messageEvents.every((e) => e.authRef?.startsWith("sconn_"))).toBe(true)
    expect(messageEvents.every((e) => typeof e.sequence === "number")).toBe(true)
  })

  test("reconstructDeliveredEvents keeps one row per connection for the same user (two devices = two deliveries)", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("multitab"), "MultiTab")
    const ws = await createWorkspace(client, "MultiTab WS")
    const stream = await createChannel(client, ws.id, `multitab-${testRunId}`, "private")
    const userId = await getUserId(client, ws.id, user.id)
    const room = `ws:${ws.id}:stream:${stream.id}`

    const socketA = createSocket(client)
    const socketB = createSocket(client)
    await connectSocket(socketA)
    await connectSocket(socketB)
    await joinRoom(socketA, room)
    await joinRoom(socketB, room)
    await pollRows("operation = 'socket.subscribe' AND actor_id = $1", [userId], (rs) => {
      const refs = rs.filter((r) => hasStreamSubject(r, stream.id))
      return new Set(refs.map((r) => r.auth_ref)).size >= 2
    })

    await sendMessage(client, ws.id, stream.id, "delivered to both connections")
    socketA.disconnect()
    socketB.disconnect()

    const delivered = await AccessLogRepository.reconstructDeliveredEvents(pool, {
      // Pad disabled: these tests assert exact interval semantics; the skew pad
      // has its own dedicated test below.
      clockSkewToleranceMs: 0,
      workspaceId: ws.id,
      streamId: stream.id,
      from: new Date(0),
      to: new Date(Date.now() + 60_000),
    })

    const messageEvents = delivered.filter((e) => e.eventType === "message_created")
    // "From where" matters: both connections received the event, so both
    // appear — deduped per connection, never collapsed per actor.
    expect(messageEvents.length).toBe(2)
    expect(new Set(messageEvents.map((e) => e.authRef)).size).toBe(2)
    expect(messageEvents.every((e) => e.actorId === userId)).toBe(true)
  })

  test("clock-skew pad widens interval edges (default) and can be disabled for exact semantics", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("skew"), "Skewed")
    const ws = await createWorkspace(client, "Skew WS")
    const stream = await createChannel(client, ws.id, `skew-${testRunId}`, "private")
    const userId = await getUserId(client, ws.id, user.id)

    await sendMessage(client, ws.id, stream.id, "sent just before a late-stamped subscribe")

    // A subscribe row app-clock stamped ~2s AFTER the message landed — the
    // shape a slightly-ahead app clock produces at a real join.
    const lateStart = new Date(Date.now() + 2_000)
    await AccessLogRepository.insert(pool, {
      id: `acc_skew_${testRunId}`,
      workspaceId: ws.id,
      occurredAt: lateStart,
      actorType: "user",
      actorId: userId,
      authRef: `sconn_skew_${testRunId}`,
      operation: "socket.subscribe",
      accessKind: "subscribe",
      outcome: "success",
      subjects: [{ type: "stream", id: stream.id }],
    })

    const base = {
      workspaceId: ws.id,
      streamId: stream.id,
      from: new Date(0),
      to: new Date(Date.now() + 60_000),
    }
    const padded = await AccessLogRepository.reconstructDeliveredEvents(pool, base)
    const exact = await AccessLogRepository.reconstructDeliveredEvents(pool, { ...base, clockSkewToleranceMs: 0 })

    const paddedForConn = padded.filter((e) => e.authRef === `sconn_skew_${testRunId}`)
    const exactForConn = exact.filter((e) => e.authRef === `sconn_skew_${testRunId}`)
    expect(paddedForConn.some((e) => e.eventType === "message_created")).toBe(true)
    expect(exactForConn.some((e) => e.eventType === "message_created")).toBe(false)
  })

  test("reconstructDeliveredEvents ignores an agent-session unsubscribe on the same connection", async () => {
    // An agent-session-room subscription carries both {agent_session} and
    // {stream} subjects (socket.ts join site). Leaving the agent-session room
    // while staying in the stream room must NOT close the stream-room interval:
    // events delivered after that leave were still received (§3 "never claim
    // less"). Rows are seeded directly — an agent_session room join needs a live
    // session; the SQL pairing is what this exercises.
    const wsId = `workspace_recon_${testRunId}`
    const streamId = `stream_recon_${testRunId}`
    const sconn = `sconn_recon_${testRunId}`
    const userId = `usr_recon_${testRunId}`
    const sessionId = `agsess_recon_${testRunId}`
    // Anchor mid-current-UTC-month so the seeded rows always land in a live
    // partition (the migration seeds current + next month); a fixed calendar
    // date would fail once retention drops that month's partition.
    const nowUtc = new Date()
    const base = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), 15, 10, 0, 0)
    const at = (offsetMs: number) => new Date(base + offsetMs).toISOString()

    await pool.query(`DELETE FROM access_log WHERE workspace_id = $1`, [wsId])
    await pool.query(`DELETE FROM stream_events WHERE stream_id = $1`, [streamId])

    const insertAccess = (kind: string, subjects: unknown[], occurredAt: string) =>
      pool.query(
        `INSERT INTO access_log (id, workspace_id, occurred_at, actor_type, actor_id, auth_ref, operation, access_kind, outcome, subjects)
         VALUES ($1,$2,$3,'user',$4,$5,$6,$7,'success',$8::jsonb)`,
        [
          `acc_${Math.random().toString(36).slice(2)}`,
          wsId,
          occurredAt,
          userId,
          sconn,
          kind === "subscribe" ? "socket.subscribe" : "socket.unsubscribe",
          kind,
          JSON.stringify(subjects),
        ]
      )
    const insertEvent = (seq: number, createdAt: string) =>
      pool.query(
        `INSERT INTO stream_events (id, stream_id, sequence, event_type, actor_id, actor_type, payload, created_at)
         VALUES ($1,$2,$3,'message_created',$4,'user','{}'::jsonb,$5)`,
        [`evt_${Math.random().toString(36).slice(2)}`, streamId, seq, userId, createdAt]
      )

    await insertAccess("subscribe", [{ type: "stream", id: streamId }], at(0))
    await insertAccess(
      "subscribe",
      [
        { type: "agent_session", id: sessionId },
        { type: "stream", id: streamId },
      ],
      at(1000)
    )
    await insertEvent(1, at(1500))
    await insertAccess(
      "unsubscribe",
      [
        { type: "agent_session", id: sessionId },
        { type: "stream", id: streamId },
      ],
      at(2000)
    )
    await insertEvent(2, at(3000))
    await insertAccess("unsubscribe", [{ type: "stream", id: streamId }], at(4000))

    const delivered = await AccessLogRepository.reconstructDeliveredEvents(pool, {
      // Pad disabled: these tests assert exact interval semantics; the skew pad
      // has its own dedicated test below.
      clockSkewToleranceMs: 0,
      workspaceId: wsId,
      streamId,
      from: new Date(base - 60_000),
      to: new Date(base + 60_000),
    })

    const seqs = delivered
      .filter((e) => e.eventType === "message_created")
      .map((e) => e.sequence)
      .sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2])

    await pool.query(`DELETE FROM access_log WHERE workspace_id = $1`, [wsId])
    await pool.query(`DELETE FROM stream_events WHERE stream_id = $1`, [streamId])
  })

  test("reconstructDeliveredEvents treats an unclosed interval as open-ended", async () => {
    const client = new TestClient()
    const user = await loginAs(client, email("open"), "Open Interval")
    const ws = await createWorkspace(client, "Open WS")
    const stream = await createChannel(client, ws.id, `open-${testRunId}`, "private")
    const userId = await getUserId(client, ws.id, user.id)

    const socket = createSocket(client)
    await connectSocket(socket)
    await joinRoom(socket, `ws:${ws.id}:stream:${stream.id}`)

    await pollRows("operation = 'socket.subscribe' AND actor_id = $1", [userId], (rs) =>
      rs.some((r) => hasStreamSubject(r, stream.id))
    )

    // No leave/disconnect: the interval stays open, so a later event is still
    // attributed as delivered (over-approximation is the safe direction).
    await sendMessage(client, ws.id, stream.id, "after open subscribe")

    const delivered = await AccessLogRepository.reconstructDeliveredEvents(pool, {
      // Pad disabled: these tests assert exact interval semantics; the skew pad
      // has its own dedicated test below.
      clockSkewToleranceMs: 0,
      workspaceId: ws.id,
      streamId: stream.id,
      from: new Date(0),
      to: new Date(Date.now() + 60_000),
    })
    const messageEvents = delivered.filter((e) => e.eventType === "message_created")
    expect(messageEvents.length).toBe(1)
    expect(messageEvents[0]!.actorId).toBe(userId)

    socket.disconnect()
  })
})
