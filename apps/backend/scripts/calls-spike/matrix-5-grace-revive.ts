/**
 * Matrix 5 — empty-grace + revive + sweep correctness.
 *
 * Last participant leaves ⇒ call enters `empty_grace` (reason `completed`). A join
 * during grace revives it to `active`; the grace sweeper must NOT end a revived
 * call (join-vs-reap write-skew guard). When grace genuinely expires, the sweeper
 * ends the call with the reason recorded at grace entry.
 *
 * Service-driven against real Postgres (no backend instance): the grace/revive
 * transitions and the sweep are exactly the production `CallService` code paths.
 * Knob: CALLS_SPIKE_DB_URL.
 */

import {
  preflight,
  makePool,
  ensureMigrations,
  startFakeCfServer,
  makeCallService,
  seedChannel,
  cleanupWorkspace,
  callRow,
  countJoinedParticipants,
  fastForwardGrace,
  reportResult,
  allPass,
  type MatrixCheck,
} from "./harness"

async function run() {
  await preflight()
  const pool = makePool()
  await ensureMigrations(pool)
  const cf = startFakeCfServer()
  const svc = makeCallService(pool, cf.url)

  const checks: MatrixCheck[] = []
  const metrics: Record<string, number | string> = {}
  let wsId = ""
  try {
    const ctx = await seedChannel(pool, 2, "grace")
    wsId = ctx.workspaceId
    const [a, b] = ctx.users

    // A starts + is joined with a leased endpoint.
    const start = await svc.startCall({ workspaceId: wsId, streamId: ctx.streamId, userId: a.id, mode: "audio_only" })
    const callId = start.call.id

    // A leaves (its only endpoint) ⇒ last leave ⇒ empty_grace(completed).
    await svc.leaveCall({ workspaceId: wsId, callId, userId: a.id, endpointId: start.endpoint.id })
    const afterLeave = await callRow(pool, callId)
    checks.push({
      name: "last leave enters empty_grace(completed)",
      pass: afterLeave?.status === "empty_grace" && afterLeave.ended_reason === "completed",
      detail: `status=${afterLeave?.status} reason=${afterLeave?.ended_reason}`,
    })

    // B joins DURING grace ⇒ revive to active, grace cleared.
    const join = await svc.joinCall({ workspaceId: wsId, callId, userId: b.id })
    const afterRevive = await callRow(pool, callId)
    checks.push({
      name: "join during grace revives to active (reason cleared)",
      pass: afterRevive?.status === "active" && afterRevive.ended_reason === null,
      detail: `status=${afterRevive?.status} reason=${afterRevive?.ended_reason}`,
    })

    // Sweeper must NOT end a revived (active) call — even though we push "time" forward.
    await fastForwardGrace(pool, callId) // no-op on an active row (grace_deadline is null), belt-and-suspenders
    const ended1 = await svc.endGraceExpiredCalls(new Date())
    const afterSweep = await callRow(pool, callId)
    const joinedNow = await countJoinedParticipants(pool, callId)
    checks.push({
      name: "grace sweep never ends a revived call",
      pass: afterSweep?.status === "active" && ended1.ended === 0 && joinedNow === 1,
      detail: `status=${afterSweep?.status} sweptEnded=${ended1.ended} joined=${joinedNow}`,
    })

    // B leaves ⇒ empty_grace again; fast-forward the deadline; sweep ends it.
    await svc.leaveCall({ workspaceId: wsId, callId, userId: b.id, endpointId: join.endpoint.id })
    const afterSecondLeave = await callRow(pool, callId)
    await fastForwardGrace(pool, callId)
    const ended2 = await svc.endGraceExpiredCalls(new Date())
    const final = await callRow(pool, callId)
    metrics.secondGraceStatus = afterSecondLeave?.status ?? "null"
    metrics.endedCount = ended2.ended
    checks.push({
      name: "expired grace ends the call with the entry reason (completed)",
      pass: final?.status === "ended" && final.ended_reason === "completed" && ended2.ended === 1,
      detail: `status=${final?.status} reason=${final?.ended_reason} ended=${ended2.ended}`,
    })

    reportResult({ matrix: "matrix-5-grace-revive", pass: allPass(checks), checks, metrics })
  } catch (err) {
    reportResult({
      matrix: "matrix-5-grace-revive",
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
