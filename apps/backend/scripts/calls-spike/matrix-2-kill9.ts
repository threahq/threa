/**
 * Matrix 2 — `kill -9` the instance holding a live call (the crash exit criterion).
 *
 * userA's `/calls` socket + CF session live on instance A; instance B runs only as
 * the surviving sweeper. We SIGKILL instance A mid-call. Because the endpoint lease
 * is persisted (not in-memory), instance B's sweeper reaps the stranded endpoint
 * once the lease lapses, cascades the participant to `left`, graces then ends the
 * emptied call (reason `reaped`), and best-effort closes the CF session — so ZERO
 * rows are left stranded and no CF session lingers to the inactivity timeout.
 *
 * To keep the run deterministic and fast, the persisted lease/grace deadlines are
 * fast-forwarded into the past (simulating ENDPOINT_LEASE_TTL_MS / EMPTY_GRACE_MS
 * of wall clock elapsing — the documented reap mechanism); the reap + CF close are
 * then performed by instance B's REAL 15 s sweeper, not by the harness.
 *
 * Knob: CALLS_SPIKE_DB_URL. ENDPOINT_LEASE_TTL_MS / EMPTY_GRACE_MS are 45 s in
 * production (reported below); a live-clock run would take lease-TTL + sweep-cadence.
 */

import {
  preflight,
  makePool,
  ensureMigrations,
  startFakeCfServer,
  startInstance,
  makeCallService,
  seedChannel,
  cleanupWorkspace,
  callRow,
  countLiveEndpoints,
  countJoinedParticipants,
  endpointRow,
  fastForwardLease,
  fastForwardGrace,
  pollUntil,
  CallSocket,
  SWEEP_INTERVAL_MS,
  ENDPOINT_LEASE_TTL_MS,
  EMPTY_GRACE_MS,
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
  const metrics: Record<string, number | string> = {
    leaseTtlMs: ENDPOINT_LEASE_TTL_MS,
    emptyGraceMs: EMPTY_GRACE_MS,
    sweepIntervalMs: SWEEP_INTERVAL_MS,
  }
  let wsId = ""
  const sockets: CallSocket[] = []
  let instA: Awaited<ReturnType<typeof startInstance>> | null = null
  let instB: Awaited<ReturnType<typeof startInstance>> | null = null
  try {
    instA = await startInstance({ label: "A", fakeCfBase: cf.url }) // holds the call
    instB = await startInstance({ label: "B", fakeCfBase: cf.url }) // surviving sweeper

    const ctx = await seedChannel(pool, 1, "kill9")
    wsId = ctx.workspaceId
    const a = ctx.users[0]

    const start = await svc.startCall({ workspaceId: wsId, streamId: ctx.streamId, userId: a.id, mode: "video" })
    const callId = start.call.id

    // A binds its socket on instance A.
    const sockA = new CallSocket(instA.url, a.cookie, "A")
    sockets.push(sockA)
    await sockA.connect()
    const joinA = await sockA.join({ workspaceId: wsId, callId, mediaIncarnation: "incA" })
    if (!joinA.ok) throw new Error(`A join failed: ${joinA.code}`)
    const endpointId = joinA.data!.endpointId

    // Give the endpoint a CF session (via the fake), so the reaper has something to close.
    const cfSession = await svc.createEndpointCfSession({
      workspaceId: wsId,
      callId,
      userId: a.id,
      endpointId,
      mediaIncarnation: "incA",
    })
    const cfSessionId = cfSession.cfSessionId
    metrics.cfSessionId = cfSessionId

    // Prove the lease is being kept alive by renewal (what the dead instance can no longer do).
    const before = await endpointRow(pool, endpointId)
    const renew = await sockA.renew()
    const after = await endpointRow(pool, endpointId)
    checks.push({
      name: "live renewal extends the lease (pre-crash)",
      pass: renew.ok && !!after && !!before && after.lease_expires_at.getTime() >= before.lease_expires_at.getTime(),
      detail: `renewOk=${renew.ok}`,
    })

    const closesBefore = cf.closeCalls().length

    // ── CRASH ──
    instA.kill9()
    await pool.query("SELECT 1") // barrier
    // Simulate the lease TTL elapsing (the owning instance is gone, nothing renews).
    await fastForwardLease(pool, endpointId)
    const tReap = Date.now()

    // Instance B's REAL sweeper reaps the stranded endpoint + cascades the participant.
    const reaped = await pollUntil(
      async () => ({
        ep: (await endpointRow(pool, endpointId))?.status,
        joined: await countJoinedParticipants(pool, callId),
        call: (await callRow(pool, callId))?.status,
      }),
      (s) => s.ep === "closed" && s.joined === 0 && s.call === "empty_grace",
      { timeoutMs: SWEEP_INTERVAL_MS + 20_000, intervalMs: 500, label: "reap→empty_grace" }
    )
    metrics.reapMs = Date.now() - tReap
    checks.push({
      name: "surviving instance's sweeper reaps the stranded endpoint + graces the call",
      pass: reaped.ep === "closed" && reaped.joined === 0 && reaped.call === "empty_grace",
      detail: `ep=${reaped.ep} joined=${reaped.joined} call=${reaped.call} in ${metrics.reapMs}ms`,
    })

    // Simulate the empty-grace window elapsing; B's sweeper ends the call (reason reaped).
    await fastForwardGrace(pool, callId)
    const tEnd = Date.now()
    const ended = await pollUntil(
      async () => await callRow(pool, callId),
      (r) => r?.status === "ended",
      { timeoutMs: SWEEP_INTERVAL_MS + 20_000, intervalMs: 500, label: "grace→ended" }
    )
    metrics.endMs = Date.now() - tEnd
    checks.push({
      name: "emptied call ends with reason 'reaped'",
      pass: ended?.status === "ended" && ended.ended_reason === "reaped",
      detail: `status=${ended?.status} reason=${ended?.ended_reason} in ${metrics.endMs}ms`,
    })

    // The reaper closed the stranded CF session (best-effort) via the fake.
    const closedForSession = await pollUntil(
      async () => cf.closeCalls().some((c) => c.sessionId === cfSessionId),
      (v) => v === true,
      { timeoutMs: 10_000, intervalMs: 300, label: "cf-close" }
    ).catch(() => false)
    metrics.cfCloseCalls = cf.closeCalls().length - closesBefore
    checks.push({
      name: "sweeper closed the stranded CF session (no orphaned session)",
      pass: closedForSession === true,
      detail: `closeCalls(delta)=${metrics.cfCloseCalls} matchedSession=${closedForSession}`,
    })

    // THE exit criterion: zero stranded rows.
    const liveEndpoints = await countLiveEndpoints(pool, callId)
    const joined = await countJoinedParticipants(pool, callId)
    const finalCall = await callRow(pool, callId)
    checks.push({
      name: "ZERO stranded rows (no live endpoints, no joined participants, call ended)",
      pass: liveEndpoints === 0 && joined === 0 && finalCall?.status === "ended",
      detail: `liveEndpoints=${liveEndpoints} joined=${joined} call=${finalCall?.status}`,
    })

    reportResult({ matrix: "matrix-2-kill9", pass: allPass(checks), checks, metrics })
  } catch (err) {
    reportResult({
      matrix: "matrix-2-kill9",
      pass: false,
      checks,
      metrics,
      error: err instanceof Error ? err.message : String(err),
    })
    process.exitCode = 1
  } finally {
    for (const s of sockets) s.disconnect()
    if (wsId) await cleanupWorkspace(pool, wsId).catch(() => {})
    await instA?.stop().catch(() => {})
    await instB?.stop()
    cf.stop()
    await pool.end()
  }
}

if (import.meta.main) {
  run().then(() => process.exit(process.exitCode ?? 0))
}
