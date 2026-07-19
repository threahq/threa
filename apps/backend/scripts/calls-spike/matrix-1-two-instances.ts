/**
 * Matrix 1 — a call spanning sockets on TWO backend instances.
 *
 * userA's `/calls` socket lives on instance A, userB's on instance B (distinct
 * processes, one shared DB). Exit criteria: join / state / leave fan-out reaches
 * the socket on the OTHER instance (proving the socket.io Postgres adapter carries
 * the roster cross-instance), and a participant removal evicts the removed user's
 * endpoint + hides them from the roster the surviving instance broadcasts.
 *
 * Knob: CALLS_SPIKE_DB_URL. Two backend instances are spawned on free ports.
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
  CallSocket,
  type RosterEvent,
  reportResult,
  allPass,
  type MatrixCheck,
} from "./harness"

const hasUser = (e: RosterEvent, userId: string) => e.roster.some((r) => r.userId === userId)
const rosterUserCount = (e: RosterEvent) => e.roster.length

async function run() {
  await preflight()
  const pool = makePool()
  await ensureMigrations(pool)
  const cf = startFakeCfServer()
  const svc = makeCallService(pool, cf.url)

  const checks: MatrixCheck[] = []
  const metrics: Record<string, number | string> = {}
  let wsId = ""
  const sockets: CallSocket[] = []
  let instA: Awaited<ReturnType<typeof startInstance>> | null = null
  let instB: Awaited<ReturnType<typeof startInstance>> | null = null
  try {
    instA = await startInstance({ label: "A", fakeCfBase: cf.url })
    instB = await startInstance({ label: "B", fakeCfBase: cf.url })

    const ctx = await seedChannel(pool, 2, "twoinst")
    wsId = ctx.workspaceId
    const [a, b] = ctx.users

    // Create the call (REST-style start admits A); A then binds its socket on instance A.
    const start = await svc.startCall({ workspaceId: wsId, streamId: ctx.streamId, userId: a.id, mode: "video" })
    const callId = start.call.id

    const sockA = new CallSocket(instA.url, a.cookie, "A")
    const sockB = new CallSocket(instB.url, b.cookie, "B")
    sockets.push(sockA, sockB)
    await sockA.connect()
    await sockB.connect()

    const joinA = await sockA.join({ workspaceId: wsId, callId, mediaIncarnation: "incA" })
    if (!joinA.ok) throw new Error(`A join failed: ${joinA.code}`)

    // B joins on instance B → its roster broadcast must reach A's socket cross-instance.
    const t0 = Date.now()
    const joinB = await sockB.join({ workspaceId: wsId, callId, mediaIncarnation: "incB" })
    if (!joinB.ok) throw new Error(`B join failed: ${joinB.code}`)
    const crossJoin = await sockA.waitRoster((e) => rosterUserCount(e) === 2 && hasUser(e, b.id))
    metrics.crossInstanceJoinMs = Date.now() - t0
    checks.push({
      name: "B's join (instance B) fans out to A's socket (instance A)",
      pass: hasUser(crossJoin, a.id) && hasUser(crossJoin, b.id),
      detail: `roster=${crossJoin.roster.map((r) => r.userId).join(",")}`,
    })

    // State fan-out: A mutes on instance A → B (instance B) sees A muted.
    const stateAck = await sockA.state({ muted: true })
    const crossState = await sockB.waitRoster(
      (e) => e.roster.find((r) => r.userId === a.id)?.mediaState?.muted === true
    )
    checks.push({
      name: "A's mute (instance A) fans out to B's socket (instance B)",
      pass: stateAck.ok && crossState.roster.find((r) => r.userId === a.id)?.mediaState?.muted === true,
      detail: `stateAck=${stateAck.ok}`,
    })

    // Leave fan-out: B leaves on instance B → A (instance A) sees B gone.
    await sockB.leave()
    const crossLeave = await sockA.waitRoster((e) => rosterUserCount(e) === 1 && !hasUser(e, b.id))
    checks.push({
      name: "B's leave (instance B) fans out to A's socket (instance A)",
      pass: hasUser(crossLeave, a.id) && !hasUser(crossLeave, b.id),
      detail: `roster=${crossLeave.roster.map((r) => r.userId).join(",")}`,
    })

    // Cross-instance removal: B rejoins on instance B, A removes B (via the service, as
    // a future host-control path would). B's endpoint must close and the roster the
    // surviving instance broadcasts must drop B — B's own socket observes its eviction.
    const rejoinB = await sockB.join({ workspaceId: wsId, callId, mediaIncarnation: "incB2" })
    if (!rejoinB.ok) throw new Error(`B rejoin failed: ${rejoinB.code}`)
    await sockA.waitRoster((e) => rosterUserCount(e) === 2) // ensure rejoin settled
    sockB.rosters.length = 0

    await svc.removeParticipant({ workspaceId: wsId, callId, byUserId: a.id, targetUserId: b.id })
    const removedRow = await pool.query<{ status: string }>(
      `SELECT status FROM call_participants WHERE call_id = $1 AND user_id = $2`,
      [callId, b.id]
    )
    const bLiveEndpoints = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM call_endpoints e JOIN call_participants p ON p.id = e.participant_id
       WHERE p.call_id = $1 AND p.user_id = $2 AND e.status IN ('connected','reconnecting')`,
      [callId, b.id]
    )
    checks.push({
      name: "removal marks B removed + closes B's endpoints (cross-instance state)",
      pass: removedRow.rows[0]?.status === "removed" && Number(bLiveEndpoints.rows[0]?.n) === 0,
      detail: `bStatus=${removedRow.rows[0]?.status} bLiveEndpoints=${bLiveEndpoints.rows[0]?.n}`,
    })

    // Trigger a fresh roster broadcast from instance A (A toggles mute); B's socket,
    // still in the call room on instance B, must receive a roster that no longer lists B.
    await sockA.state({ muted: false })
    const evict = await sockB.waitRoster((e) => !hasUser(e, b.id))
    checks.push({
      name: "surviving instance's roster evicts B on B's own socket",
      pass: hasUser(evict, a.id) && !hasUser(evict, b.id),
      detail: `roster=${evict.roster.map((r) => r.userId).join(",")}`,
    })

    reportResult({ matrix: "matrix-1-two-instances", pass: allPass(checks), checks, metrics })
  } catch (err) {
    reportResult({
      matrix: "matrix-1-two-instances",
      pass: false,
      checks,
      metrics,
      error: err instanceof Error ? err.message : String(err),
    })
    process.exitCode = 1
  } finally {
    for (const s of sockets) s.disconnect()
    if (wsId) await cleanupWorkspace(pool, wsId).catch(() => {})
    await instA?.stop()
    await instB?.stop()
    cf.stop()
    await pool.end()
  }
}

if (import.meta.main) {
  run().then(() => process.exit(process.exitCode ?? 0))
}
