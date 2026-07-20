/**
 * Matrix 4 — product glare under real concurrency.
 *
 * N users fire `startCall` on the SAME stream simultaneously against real
 * Postgres (not SQL-capture). Exit criterion: exactly one `calls` row ever exists
 * for the stream, every caller lands in that one call as a joined participant, and
 * the one-active-call-per-stream partial unique index holds under the race.
 *
 * Knobs: CALLS_SPIKE_GLARE_N (default 12) concurrent starters; CALLS_SPIKE_DB_URL.
 * No backend instance needed — this exercises the transaction/CAS path directly.
 */

import {
  preflight,
  makePool,
  ensureMigrations,
  startFakeCfServer,
  makeCallService,
  seedChannel,
  cleanupWorkspace,
  activeCallsForStream,
  reportResult,
  allPass,
  type MatrixCheck,
} from "./harness"

const N = Number(process.env.CALLS_SPIKE_GLARE_N) || 12

async function run() {
  await preflight()
  const pool = makePool()
  await ensureMigrations(pool)
  const cf = startFakeCfServer()
  const svc = makeCallService(pool, cf.url)

  const checks: MatrixCheck[] = []
  const metrics: Record<string, number | string> = { concurrentStarters: N }
  let wsId = ""
  try {
    const ctx = await seedChannel(pool, N, "glare")
    wsId = ctx.workspaceId

    // Fire N concurrent startCall for N distinct users on the one stream.
    const results = await Promise.allSettled(
      ctx.users.map((u) => svc.startCall({ workspaceId: wsId, streamId: ctx.streamId, userId: u.id, mode: "video" }))
    )
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof svc.startCall>>
    >[]
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
    metrics.startsFulfilled = fulfilled.length
    metrics.startsRejected = rejected.length

    const distinctCallIds = new Set(fulfilled.map((r) => r.value.call.id))
    const createdTrue = fulfilled.filter((r) => r.value.created).length
    metrics.distinctCallIds = distinctCallIds.size
    metrics.createdTrueCount = createdTrue

    // Exactly one active call row for the stream.
    const active = await activeCallsForStream(pool, ctx.streamId)
    metrics.activeCallRows = active
    checks.push({ name: "exactly one active call row for the stream", pass: active === 1, detail: `active=${active}` })

    // Every fulfilled caller resolved to the SAME call id.
    checks.push({
      name: "all callers landed in one call",
      pass: distinctCallIds.size === 1 && fulfilled.length === N,
      detail: `distinctCallIds=${distinctCallIds.size} fulfilled=${fulfilled.length}/${N}`,
    })

    // Exactly one starter observed created=true (the unique-index winner); the rest re-read it.
    checks.push({
      name: "exactly one winner minted the call (created=true), rest re-read",
      pass: createdTrue === 1,
      detail: `created=true count=${createdTrue}`,
    })

    // Every caller is a joined participant of that call.
    const theCallId = [...distinctCallIds][0]
    let joined = 0
    if (theCallId) {
      const r = await pool.query<{ n: string }>(
        `SELECT COUNT(DISTINCT user_id)::int AS n FROM call_participants WHERE call_id = $1 AND status = 'joined'`,
        [theCallId]
      )
      joined = Number(r.rows[0]?.n ?? 0)
    }
    metrics.joinedParticipants = joined
    checks.push({
      name: "every caller is a joined participant",
      pass: joined === N,
      detail: `joined=${joined}/${N}`,
    })

    reportResult({ matrix: "matrix-4-glare", pass: allPass(checks), checks, metrics })
  } catch (err) {
    reportResult({
      matrix: "matrix-4-glare",
      pass: false,
      checks,
      metrics,
      error: err instanceof Error ? err.message : String(err),
    })
    process.exitCode = 1
  } finally {
    if (wsId) await cleanupWorkspace(pool, wsId).catch(() => {})
    cf.stop()
    await pool.end()
  }
}

if (import.meta.main) {
  run().then(() => process.exit(process.exitCode ?? 0))
}
