/**
 * Matrix 3 — one user, two devices (endpoint identity + takeover fence).
 *
 * userA joins from socket 1 (instance A). A second concurrent device (socket 2,
 * instance B) is rejected with CALL_ENDPOINT_ACTIVE unless it asks for takeover.
 * With takeover the old endpoint is closed and a higher epoch minted; the old
 * device's lease renew then fails the epoch fence (CALL_LEASE_SUPERSEDED), i.e.
 * the old socket's binding is invalidated.
 *
 * Knob: CALLS_SPIKE_DB_URL. Two backend instances spawned on free ports.
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
  endpointRow,
  CallSocket,
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
  const sockets: CallSocket[] = []
  let instA: Awaited<ReturnType<typeof startInstance>> | null = null
  let instB: Awaited<ReturnType<typeof startInstance>> | null = null
  try {
    instA = await startInstance({ label: "A", fakeCfBase: cf.url })
    instB = await startInstance({ label: "B", fakeCfBase: cf.url })

    const ctx = await seedChannel(pool, 2, "twodev")
    wsId = ctx.workspaceId
    const a = ctx.users[0]

    const start = await svc.startCall({ workspaceId: wsId, streamId: ctx.streamId, userId: a.id, mode: "video" })
    const callId = start.call.id

    // Device 1 on instance A.
    const dev1 = new CallSocket(instA.url, a.cookie, "dev1")
    const dev2 = new CallSocket(instB.url, a.cookie, "dev2")
    sockets.push(dev1, dev2)
    await dev1.connect()
    await dev2.connect()

    const join1 = await dev1.join({ workspaceId: wsId, callId, mediaIncarnation: "dev1-inc" })
    if (!join1.ok) throw new Error(`dev1 join failed: ${join1.code}`)
    const epoch1 = join1.data!.epoch
    const ep1Id = join1.data!.endpointId
    metrics.epoch1 = epoch1

    // Device 2, no takeover → rejected.
    const join2NoTakeover = await dev2.join({ workspaceId: wsId, callId, mediaIncarnation: "dev2-inc" })
    checks.push({
      name: "second device without takeover is rejected (CALL_ENDPOINT_ACTIVE)",
      pass: !join2NoTakeover.ok && join2NoTakeover.code === "CALL_ENDPOINT_ACTIVE",
      detail: `ok=${join2NoTakeover.ok} code=${join2NoTakeover.code}`,
    })

    // Device 2, takeover → succeeds, closes dev1's endpoint, mints a higher epoch.
    const join2Takeover = await dev2.join({ workspaceId: wsId, callId, mediaIncarnation: "dev2-inc", takeover: true })
    const epoch2 = join2Takeover.data?.epoch ?? -1
    const ep2Id = join2Takeover.data?.endpointId
    metrics.epoch2 = epoch2
    const ep1After = await endpointRow(pool, ep1Id)
    checks.push({
      name: "takeover admits device 2 with a higher epoch + closes device 1's endpoint",
      pass: join2Takeover.ok && epoch2 > epoch1 && ep2Id !== ep1Id && ep1After?.status === "closed",
      detail: `epoch1=${epoch1} epoch2=${epoch2} ep1Status=${ep1After?.status} sameEp=${ep2Id === ep1Id}`,
    })

    // Device 1's lease renew now fails the epoch fence (its endpoint was closed).
    const renew1 = await dev1.renew()
    checks.push({
      name: "old device's lease renew is fenced off (CALL_LEASE_SUPERSEDED)",
      pass: !renew1.ok && renew1.code === "CALL_LEASE_SUPERSEDED",
      detail: `ok=${renew1.ok} code=${renew1.code}`,
    })

    // Device 2's renew still works (it holds the live endpoint).
    const renew2 = await dev2.renew()
    checks.push({
      name: "new device's lease renew succeeds",
      pass: renew2.ok === true,
      detail: `ok=${renew2.ok} code=${renew2.code ?? "-"}`,
    })

    reportResult({ matrix: "matrix-3-two-devices", pass: allPass(checks), checks, metrics })
  } catch (err) {
    reportResult({
      matrix: "matrix-3-two-devices",
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
