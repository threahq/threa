/**
 * Calls spike — control-plane hostile-matrix harness (PR 0.3, Half A).
 *
 * Boots N real backend instances against ONE local Postgres database (default
 * `threa_test`) on distinct ports, all pointed at a local fake Cloudflare server
 * (`fake-cf-server.ts`) so the calls surfaces run with `cloudflareEnabled=true`
 * without a live CF dev account (the endpoint/lease/sweep machinery under test
 * needs no real media). Provides seeding (workspace/users/DM/channel via the
 * production repositories), a socket.io `/calls` client, a pool-side `CallService`
 * for driving sweeps deterministically, and `kill -9` / fast-forward knobs.
 *
 * ── Knobs (env) ──────────────────────────────────────────────────────────────
 *   CALLS_SPIKE_DB_URL   Postgres URL for the shared DB. Default
 *                        postgresql://threa:threa@localhost:5454/threa_test.
 *                        NEVER point this at a DB a live `dev:test` stack is using
 *                        (the sweeper reaps any lapsed endpoint globally).
 *   CALLS_SPIKE_VERBOSE  "1" streams each spawned backend's stdout/stderr.
 *
 * Every timing constant the matrix depends on (lease TTL, empty-grace, sweep
 * cadence) is imported from the production `calls/config.ts` + `sweeper.ts` so
 * the numbers in the findings are the real ones. The sweep cadence is the
 * backend's own 15 s `createCallSweeper` interval; `matrix-2` fast-forwards the
 * persisted lease/grace deadlines into the past to simulate the TTL elapsing
 * (the documented reap mechanism) rather than sleeping 45 s of wall clock.
 */

import { spawn, type Subprocess } from "bun"
import * as net from "net"
import { Pool } from "pg"
import { io, type Socket } from "socket.io-client"
import { createDatabasePool, withTransaction } from "../../src/db"
import { createMigrator } from "../../src/db/migrations"
import { workspaceId as newWorkspaceId, userId as newUserId, streamId as newStreamId } from "../../src/lib/id"
import { WorkspaceRepository } from "../../src/features/workspaces/repository"
import { UserRepository } from "../../src/features/workspaces/user-repository"
import { StreamRepository } from "../../src/features/streams/repository"
import { StreamMemberRepository } from "../../src/features/streams/member-repository"
import { WorkspaceSettingsRepository } from "../../src/features/workspace-settings/repository"
import { CallService, CloudflareRealtimeApi } from "../../src/features/calls"
import { ENDPOINT_LEASE_TTL_MS, EMPTY_GRACE_MS } from "../../src/features/calls/config"

export const SWEEP_INTERVAL_MS = 15_000 // createCallSweeper default in server.ts
export { ENDPOINT_LEASE_TTL_MS, EMPTY_GRACE_MS }

export const DB_URL = process.env.CALLS_SPIKE_DB_URL ?? "postgresql://threa:threa@localhost:5454/threa_test"
const VERBOSE = process.env.CALLS_SPIKE_VERBOSE === "1"

// A Ctrl-C without teardown would orphan spawned backends whose GLOBAL 15s
// sweeper keeps reaping lapsed endpoints across all of threa_test — including a
// co-resident dev stack's live calls. Kill every registered child before dying.
const spawnedProcs = new Set<Subprocess>()
let signalHandlersInstalled = false
function installSignalTeardown() {
  if (signalHandlersInstalled) return
  signalHandlersInstalled = true
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      for (const p of spawnedProcs) {
        try {
          p.kill(9)
        } catch {
          // already dead
        }
      }
      process.exit(sig === "SIGINT" ? 130 : 143)
    })
  }
}

// ── ports ──────────────────────────────────────────────────────────────────

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (addr && typeof addr === "object") srv.close(() => resolve(addr.port))
      else srv.close(() => reject(new Error("no port")))
    })
  })
}

async function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(500)
    sock.once("connect", () => {
      sock.destroy()
      resolve(true)
    })
    sock.once("timeout", () => {
      sock.destroy()
      resolve(false)
    })
    sock.once("error", () => resolve(false))
    sock.connect(port, host)
  })
}

// ── preflight + DB ───────────────────────────────────────────────────────────

/** Fail loudly (INV-11) if Postgres is unreachable — the whole matrix is moot without it. */
export async function preflight(): Promise<void> {
  const u = new URL(DB_URL)
  const pgPort = Number(u.port || 5432)
  if (!(await portOpen(pgPort, u.hostname))) {
    throw new Error(
      `Postgres not reachable at ${u.hostname}:${pgPort}. Run 'bun run db:start' first. ` +
        `(CALLS_SPIKE_DB_URL=${DB_URL})`
    )
  }
}

export function makePool(): Pool {
  return createDatabasePool(DB_URL, { max: 6 })
}

export async function ensureMigrations(pool: Pool): Promise<void> {
  await createMigrator(pool).up()
}

// ── fake CF ──────────────────────────────────────────────────────────────────

export { startFakeCfServer } from "./fake-cf-server"

// ── backend instances ──────────────────────────────────────────────────────

export interface BackendInstance {
  label: string
  port: number
  url: string
  proc: Subprocess
  kill9: () => void
  stop: () => Promise<void>
}

/**
 * Spawn one real backend (`apps/backend/src/index.ts`) against the shared DB on a
 * free port, wired to the fake CF base. Pools are shrunk (main 6 / listen 3 /
 * realtime 3) so several instances plus any co-resident dev stack stay under
 * Postgres's connection cap. Resolves once `/health` answers.
 */
export async function startInstance(opts: {
  label: string
  /** Fake CF base (Half A). Ignored when `cf` is supplied (Half B live CF). */
  fakeCfBase: string
  /** Real CF creds — Half B (`live-cf/cf-2`) points the proxy at the actual SFU. */
  cf?: { appId: string; appSecret: string; apiBase?: string }
}): Promise<BackendInstance> {
  const port = await findFreePort()
  const cfEnv = opts.cf
    ? {
        CLOUDFLARE_REALTIME_APP_ID: opts.cf.appId,
        CLOUDFLARE_REALTIME_APP_SECRET: opts.cf.appSecret,
        ...(opts.cf.apiBase ? { CLOUDFLARE_REALTIME_API_BASE: opts.cf.apiBase } : {}),
      }
    : {
        CLOUDFLARE_REALTIME_APP_ID: "fakeapp",
        CLOUDFLARE_REALTIME_APP_SECRET: "fakesecret",
        CLOUDFLARE_REALTIME_API_BASE: `${opts.fakeCfBase}/v1/apps`,
      }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DATABASE_URL: DB_URL,
    PORT: String(port),
    NODE_ENV: "test",
    REGION: "local",
    USE_STUB_AUTH: "true",
    USE_STUB_AI: "true",
    USE_STUB_COMPANION: "true",
    USE_STUB_BOUNDARY_EXTRACTION: "true",
    FAST_SHUTDOWN: "true",
    SESSION_COOKIE_NAME: "wos_session_test",
    INTERNAL_API_KEY: "test-internal-key",
    GLOBAL_RATE_LIMIT_MAX: "100000",
    AUTH_RATE_LIMIT_MAX: "100000",
    CORS_ALLOWED_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
    DATABASE_POOL_MAX: "6",
    DATABASE_LISTEN_POOL_MAX: "3",
    DATABASE_REALTIME_POOL_MAX: "3",
    DATABASE_WARM_POOL_COUNT: "0",
    // CF media plane: fake local recorder (Half A) or the real SFU (Half B).
    ...cfEnv,
    // MinIO compose bucket — server boot constructs the S3 client (never calls it
    // here) but keep it pointed at the local compose endpoint, not real AWS.
    S3_BUCKET: "threa-test-uploads",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "minioadmin",
    S3_SECRET_ACCESS_KEY: "minioadmin",
    S3_ENDPOINT: "http://localhost:9099",
  }

  installSignalTeardown()
  const proc = spawn(["bun", "apps/backend/src/index.ts"], {
    cwd: process.cwd(),
    env,
    stdout: VERBOSE ? "inherit" : "ignore",
    stderr: VERBOSE ? "inherit" : "ignore",
  })
  spawnedProcs.add(proc)
  void proc.exited.finally(() => spawnedProcs.delete(proc))

  const url = `http://localhost:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`[${opts.label}] backend exited early (code ${proc.exitCode})`)
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) {
        // Small settle so the socket.io namespace is accepting handshakes before
        // the first client connect (health can answer a beat before the upgrade path).
        await Bun.sleep(500)
        const inst: BackendInstance = {
          label: opts.label,
          port,
          url,
          proc,
          kill9: () => proc.kill(9),
          stop: async () => {
            proc.kill(15)
            await proc.exited.catch(() => {})
          },
        }
        return inst
      }
    } catch {
      // not up yet
    }
    await Bun.sleep(300)
  }
  proc.kill(9)
  throw new Error(`[${opts.label}] backend did not become healthy within 60s on :${port}`)
}

// ── seeding (direct via production repositories) ─────────────────────────────

export interface SeedUser {
  id: string
  workosUserId: string
  cookie: string
}

export interface SeedContext {
  workspaceId: string
  streamId: string
  users: SeedUser[]
}

function sessionCookie(workosUserId: string): string {
  return `wos_session_test=test_session_${workosUserId}`
}

async function seedWorkspaceAndUsers(
  client: import("pg").PoolClient,
  userCount: number,
  tag: string
): Promise<{ wsId: string; users: SeedUser[] }> {
  const wsId = newWorkspaceId()
  const rand = Math.random().toString(36).slice(2, 8)
  const users: SeedUser[] = []
  // Create users first so created_by references a real id (no FK, but tidy).
  for (let i = 0; i < userCount; i++) {
    const id = newUserId()
    const workosUserId = `workos_test_${tag}_${rand}_u${i}`
    users.push({ id, workosUserId, cookie: sessionCookie(workosUserId) })
  }
  await WorkspaceRepository.insert(client, {
    id: wsId,
    name: `calls-spike ${tag} ${rand}`,
    slug: `calls-spike-${tag}-${rand}`,
    createdBy: users[0].id,
  })
  for (let i = 0; i < users.length; i++) {
    await UserRepository.insert(client, {
      id: users[i].id,
      workspaceId: wsId,
      workosUserId: users[i].workosUserId,
      email: `${users[i].workosUserId}@spike.local`,
      name: `Spike User ${i}`,
      role: "member",
      slug: `spike-${tag}-${rand}-u${i}`,
    })
  }
  // Enable the calls feature for this workspace (REST + gateway gate on it).
  await WorkspaceSettingsRepository.setOverride(client, wsId, "callsEnabled", true)
  return { wsId, users }
}

/**
 * Seed a workspace with a PUBLIC channel + `userCount` members. Public ⇒ every
 * member has access without a membership row. The whole seed is ONE transaction:
 * a mid-seed failure must not commit partial rows the matrices' `if (wsId)
 * cleanup` guard would never see.
 */
export async function seedChannel(pool: Pool, userCount: number, tag: string): Promise<SeedContext> {
  return withTransaction(pool, async (client) => {
    const { wsId, users } = await seedWorkspaceAndUsers(client, userCount, tag)
    const sId = newStreamId()
    await StreamRepository.insert(client, {
      id: sId,
      workspaceId: wsId,
      type: "channel",
      slug: `spike-${tag}-${Math.random().toString(36).slice(2, 7)}`,
      visibility: "public",
      createdBy: users[0].id,
    })
    return { workspaceId: wsId, streamId: sId, users }
  })
}

/** Seed a workspace with a DM stream between exactly two members. One transaction, same rationale as seedChannel. */
export async function seedDm(pool: Pool, tag: string): Promise<SeedContext> {
  return withTransaction(pool, async (client) => {
    const { wsId, users } = await seedWorkspaceAndUsers(client, 2, tag)
    const sId = newStreamId()
    await StreamRepository.insert(client, {
      id: sId,
      workspaceId: wsId,
      type: "dm",
      visibility: "private",
      createdBy: users[0].id,
    })
    await StreamMemberRepository.insertMany(client, sId, [users[0].id, users[1].id])
    return { workspaceId: wsId, streamId: sId, users }
  })
}

/** Delete every row this run created for a workspace, so threa_test is never wedged for the next run. */
export async function cleanupWorkspace(pool: Pool, wsId: string): Promise<void> {
  for (const table of [
    "call_endpoints",
    "call_participants",
    "call_invitations",
    "calls",
    "stream_members",
    "streams",
    "workspace_setting_overrides",
    "users",
    "workspaces",
  ]) {
    const col = table === "workspaces" ? "id" : "workspace_id"
    // streams/stream_members are workspace-scoped; workspace_id column exists on all listed tables except workspaces.
    if (table === "stream_members") {
      await pool.query(
        `DELETE FROM stream_members WHERE stream_id IN (SELECT id FROM streams WHERE workspace_id = $1)`,
        [wsId]
      )
      continue
    }
    await pool.query(`DELETE FROM ${table} WHERE ${col} = $1`, [wsId]).catch(() => {})
  }
}

// ── pool-side CallService (drives sweeps / CF-session creation deterministically) ─

export function makeCallService(pool: Pool, fakeCfBase: string): CallService {
  const cf = new CloudflareRealtimeApi({
    appId: "fakeapp",
    appSecret: "fakesecret",
    apiBase: `${fakeCfBase}/v1/apps`,
    enabled: true,
  })
  return new CallService({ pool, cloudflare: cf })
}

// ── fast-forward knobs (simulate the lease TTL / grace window elapsing) ──────

export async function fastForwardLease(pool: Pool, endpointId: string): Promise<void> {
  await pool.query(`UPDATE call_endpoints SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [
    endpointId,
  ])
}

export async function fastForwardGrace(pool: Pool, callId: string): Promise<void> {
  await pool.query(`UPDATE calls SET grace_deadline = NOW() - INTERVAL '1 second' WHERE id = $1`, [callId])
}

// ── polling ──────────────────────────────────────────────────────────────────

export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; label?: string } = { timeoutMs: 30_000 }
): Promise<T> {
  const interval = opts.intervalMs ?? 500
  const deadline = Date.now() + opts.timeoutMs
  let last: T
  do {
    last = await fn()
    if (predicate(last)) return last
    await Bun.sleep(interval)
  } while (Date.now() < deadline)
  throw new Error(`pollUntil timed out${opts.label ? ` (${opts.label})` : ""}: last=${JSON.stringify(last!)}`)
}

// ── DB read helpers for assertions ───────────────────────────────────────────

export async function callRow(
  pool: Pool,
  callId: string
): Promise<{ status: string; ended_reason: string | null } | null> {
  const r = await pool.query<{ status: string; ended_reason: string | null }>(
    `SELECT status, ended_reason FROM calls WHERE id = $1`,
    [callId]
  )
  return r.rows[0] ?? null
}

export async function countLiveEndpoints(pool: Pool, callId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM call_endpoints WHERE call_id = $1 AND status IN ('connected','reconnecting')`,
    [callId]
  )
  return Number(r.rows[0]?.n ?? 0)
}

export async function countJoinedParticipants(pool: Pool, callId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM call_participants WHERE call_id = $1 AND status = 'joined'`,
    [callId]
  )
  return Number(r.rows[0]?.n ?? 0)
}

export async function endpointRow(
  pool: Pool,
  endpointId: string
): Promise<{ status: string; cf_session_id: string | null; epoch: number; lease_expires_at: Date } | null> {
  const r = await pool.query<{ status: string; cf_session_id: string | null; epoch: number; lease_expires_at: Date }>(
    `SELECT status, cf_session_id, epoch, lease_expires_at FROM call_endpoints WHERE id = $1`,
    [endpointId]
  )
  return r.rows[0] ?? null
}

export async function activeCallsForStream(pool: Pool, streamId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM calls WHERE stream_id = $1 AND status IN ('active','empty_grace')`,
    [streamId]
  )
  return Number(r.rows[0]?.n ?? 0)
}

// ── /calls socket client ─────────────────────────────────────────────────────

export interface JoinAck {
  ok: boolean
  error?: string
  code?: string
  data?: {
    endpointId: string
    epoch: number
    rosterVersion: number
    roster: Array<{ userId: string; connectionStatus: string | null; mediaState: Record<string, unknown> }>
    leaseTtlMs: number
  }
}

export interface RosterEvent {
  callId: string
  rosterVersion: number
  roster: Array<{
    userId: string
    participantStatus: string
    connectionStatus: string | null
    mediaState: Record<string, unknown>
  }>
}

/** A thin socket.io `/calls` client mirroring the browser control channel. */
export class CallSocket {
  readonly socket: Socket
  readonly label: string
  rosters: RosterEvent[] = []
  private renewTimer: ReturnType<typeof setInterval> | null = null
  lastRenewOk: boolean | null = null
  lastRenewCode: string | null = null

  constructor(instanceUrl: string, cookie: string, label: string) {
    this.label = label
    this.socket = io(`${instanceUrl}/calls`, {
      path: "/socket.io/",
      extraHeaders: { Cookie: cookie },
      reconnection: false,
      transports: ["polling", "websocket"],
    })
    this.socket.on("call:roster", (e: RosterEvent) => this.rosters.push(e))
  }

  async connect(timeoutMs = 8000, attempts = 3): Promise<void> {
    let lastErr: Error | null = null
    for (let i = 0; i < attempts; i++) {
      try {
        await this.connectOnce(timeoutMs)
        return
      } catch (err) {
        // A transient handshake race right after boot self-heals on a fresh
        // connect(); a real auth rejection reproduces on every attempt.
        lastErr = err instanceof Error ? err : new Error(String(err))
        this.socket.disconnect()
        await Bun.sleep(400)
        this.socket.connect()
      }
    }
    throw lastErr ?? new Error(`[${this.label}] socket connect failed`)
  }

  private connectOnce(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.socket.connected) return resolve()
      const t = setTimeout(() => {
        cleanup()
        reject(new Error(`[${this.label}] socket connect timeout`))
      }, timeoutMs)
      const onConnect = () => {
        cleanup()
        resolve()
      }
      const onError = (err: Error) => {
        cleanup()
        reject(new Error(`[${this.label}] connect_error: ${err.message}`))
      }
      const cleanup = () => {
        clearTimeout(t)
        this.socket.off("connect", onConnect)
        this.socket.off("connect_error", onError)
      }
      this.socket.on("connect", onConnect)
      this.socket.on("connect_error", onError)
    })
  }

  private emit<T>(event: string, payload: unknown, timeoutMs = 8000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`[${this.label}] ${event} ack timeout`)), timeoutMs)
      this.socket.emit(event, payload, (ack: T) => {
        clearTimeout(t)
        resolve(ack)
      })
    })
  }

  join(payload: {
    workspaceId: string
    callId: string
    mediaIncarnation: string
    takeover?: boolean
  }): Promise<JoinAck> {
    return this.emit<JoinAck>("call:join", payload)
  }

  leave(): Promise<{ ok: boolean; error?: string; code?: string }> {
    return this.emit("call:leave", {})
  }

  state(payload: { muted?: boolean; cameraOn?: boolean }): Promise<{ ok: boolean; code?: string; data?: unknown }> {
    return this.emit("call:state", payload)
  }

  renew(): Promise<{ ok: boolean; error?: string; code?: string; data?: { leaseExpiresAt: string } }> {
    return this.emit("call:lease:renew", {})
  }

  /** Renew the lease at TTL/3, as the browser client does. Tracks the last ack. */
  startRenewLoop(ttlMs: number): void {
    const period = Math.max(1000, Math.floor(ttlMs / 3))
    this.renewTimer = setInterval(async () => {
      try {
        const ack = await this.renew()
        this.lastRenewOk = ack.ok
        this.lastRenewCode = ack.code ?? null
      } catch {
        this.lastRenewOk = false
      }
    }, period)
  }

  stopRenewLoop(): void {
    if (this.renewTimer) clearInterval(this.renewTimer)
    this.renewTimer = null
  }

  /** Resolve once a roster event satisfying `pred` arrives (checks already-buffered events first). */
  async waitRoster(pred: (e: RosterEvent) => boolean, timeoutMs = 10_000): Promise<RosterEvent> {
    const existing = this.rosters.find(pred)
    if (existing) return existing
    return new Promise<RosterEvent>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`[${this.label}] waitRoster timeout`)), timeoutMs)
      const handler = (e: RosterEvent) => {
        if (pred(e)) {
          clearTimeout(t)
          this.socket.off("call:roster", handler)
          resolve(e)
        }
      }
      this.socket.on("call:roster", handler)
    })
  }

  disconnect(): void {
    this.stopRenewLoop()
    this.socket.disconnect()
  }
}

// ── result reporting ─────────────────────────────────────────────────────────

export interface MatrixCheck {
  name: string
  pass: boolean
  detail?: string
}

export interface MatrixResult {
  matrix: string
  pass: boolean
  checks: MatrixCheck[]
  metrics: Record<string, number | string>
  error?: string
}

const RESULT_MARKER = "__MATRIX_RESULT__"

/** Print a human summary then a single machine-readable line `run-all.ts` parses. */
export function reportResult(result: MatrixResult): void {
  console.log(`\n── ${result.matrix} ── ${result.pass ? "PASS" : "FAIL"} ──`)
  for (const c of result.checks) {
    console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`)
  }
  if (Object.keys(result.metrics).length) {
    console.log(`  metrics: ${JSON.stringify(result.metrics)}`)
  }
  if (result.error) console.log(`  error: ${result.error}`)
  console.log(`${RESULT_MARKER} ${JSON.stringify(result)}`)
}

export function parseResultLine(stdout: string): MatrixResult | null {
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(RESULT_MARKER))
  if (!line) return null
  try {
    return JSON.parse(line.slice(RESULT_MARKER.length).trim()) as MatrixResult
  } catch {
    return null
  }
}

export function allPass(checks: MatrixCheck[]): boolean {
  return checks.every((c) => c.pass)
}
