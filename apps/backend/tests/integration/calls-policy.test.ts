import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { Visibilities } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import { StreamService } from "../../src/features/streams"
import { CallService } from "../../src/features/calls"
import { workspaceId as newWorkspaceId } from "../../src/lib/id"

let pool: Pool
let streams: StreamService
let featureFlags: FeatureFlagService

beforeAll(async () => {
  pool = await setupTestDatabase()
  streams = new StreamService(pool)
  featureFlags = new FeatureFlagService(pool)
})

afterAll(async () => pool.end())

const turnIssuer = { issue: async () => ({ iceServers: [], expiresAt: new Date(Date.now() + 60_000).toISOString() }) }

async function scenario(size: number, p2pEnabled: boolean) {
  const workspaceId = newWorkspaceId()
  const userIds: string[] = []
  await withTransaction(pool, async (client) => {
    await WorkspaceRepository.insert(client, {
      id: workspaceId,
      name: "Call policy integration",
      slug: `policy-${workspaceId}`,
      createdBy: workspaceId,
    })
    for (let index = 0; index < size; index++)
      userIds.push((await addTestMember(client, workspaceId, `policy-${index}-${workspaceId}`)).id)
    if (p2pEnabled)
      await FeatureFlagOverrideRepository.replaceForSubject(client, workspaceId, "workspace", workspaceId, {
        callsP2p: "on",
      })
  })
  const stream = await streams.createChannel({
    workspaceId,
    slug: `policy-${workspaceId}`,
    displayName: "Call policy integration",
    createdBy: userIds[0]!,
    visibility: Visibilities.PRIVATE,
    memberIds: userIds.slice(1),
  })
  return { workspaceId, streamId: stream.id, userIds }
}

function admission(workspaceId: string, callId: string, userId: string, index: number) {
  return {
    workspaceId,
    callId,
    userId,
    mediaIncarnation: `inc_${index}`,
    transportCapability: "p2p-v1" as const,
    transferCapability: "transport-transfer-v1" as const,
  }
}

describe("automatic call transport policy on the real schema", () => {
  test("should commit one SFU request before concurrent seventh and eighth retries without ghost admission", async () => {
    const s = await scenario(8, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    for (let index = 1; index < 6; index++)
      await service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[index]!, index))

    const attempts = await Promise.allSettled([
      service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[6]!, 6)),
      service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[7]!, 7)),
    ])
    expect(attempts.map((result) => result.status === "rejected" && (result.reason as { code?: string }).code)).toEqual(
      ["CALL_TRANSPORT_PREPARING", "CALL_TRANSPORT_PREPARING"]
    )

    const beforeCommit = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM call_participants WHERE workspace_id = $1 AND call_id = $2 AND status = 'joined') AS participants,
         (SELECT count(*)::int FROM call_endpoints WHERE workspace_id = $1 AND call_id = $2 AND status IN ('connected','reconnecting')) AS endpoints,
         (SELECT count(*)::int FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2) AS transfers,
         (SELECT count(*)::int FROM outbox WHERE event_type = 'call:transport_transfer_changed' AND payload->>'callId' = $2) AS events`,
      [s.workspaceId, started.call.id]
    )
    expect(beforeCommit.rows[0]).toEqual({ participants: 6, endpoints: 6, transfers: 1, events: 1 })

    const transfer = await pool.query(
      `SELECT id, target_generation FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    await pool.query(
      `UPDATE calls SET media_transport = 'sfu', transport_generation = $3 WHERE workspace_id = $1 AND id = $2`,
      [s.workspaceId, started.call.id, transfer.rows[0].target_generation]
    )
    await pool.query(`UPDATE call_transport_transfers SET phase = 'completed' WHERE workspace_id = $1 AND id = $2`, [
      s.workspaceId,
      transfer.rows[0].id,
    ])
    await service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[6]!, 6))
    const afterCommit = await pool.query(
      `SELECT count(*)::int AS count FROM call_endpoints WHERE workspace_id = $1 AND call_id = $2 AND status IN ('connected','reconnecting')`,
      [s.workspaceId, started.call.id]
    )
    expect(afterCommit.rows[0]).toEqual({ count: 7 })
  })

  test("should create a fresh admission transfer after a settled failure", async () => {
    const s = await scenario(7, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    for (let index = 1; index < 6; index++)
      await service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[index]!, index))

    await expect(service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[6]!, 6))).rejects.toMatchObject({
      code: "CALL_TRANSPORT_PREPARING",
    })
    await pool.query(
      `UPDATE call_transport_transfers SET phase = 'failed', failure_code = 'TEST_FAILURE', version = version + 1
       WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )

    await expect(service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[6]!, 7))).rejects.toMatchObject({
      code: "CALL_TRANSPORT_PREPARING",
    })
    expect(
      (
        await pool.query(
          `SELECT generation, phase FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2 ORDER BY generation`,
          [s.workspaceId, started.call.id]
        )
      ).rows
    ).toEqual([
      { generation: 2, phase: "failed" },
      { generation: 3, phase: "preparing" },
    ])
  })

  test("should periodically reconcile active calls and avoid unchanged policy writes", async () => {
    const s = await scenario(1, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    const initial = await pool.query(
      `SELECT version FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    await FeatureFlagOverrideRepository.replaceForSubject(pool, s.workspaceId, "workspace", s.workspaceId, {
      callsP2p: "off",
    })

    await service.sweepTransportPolicy(new Date())
    const afterSafety = await pool.query(
      `SELECT version, latest_reason FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    expect(afterSafety.rows[0]).toEqual({ version: initial.rows[0].version + 1, latest_reason: "rollout_flag_off" })
    expect(
      (
        await pool.query(
          `SELECT target_transport, cause FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2`,
          [s.workspaceId, started.call.id]
        )
      ).rows
    ).toEqual([{ target_transport: "sfu", cause: "rollout_safety" }])

    await service.sweepTransportPolicy(new Date())
    const stable = await pool.query(
      `SELECT version FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    await service.sweepTransportPolicy(new Date())
    expect(
      (
        await pool.query(`SELECT version FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`, [
          s.workspaceId,
          started.call.id,
        ])
      ).rows[0]
    ).toEqual(stable.rows[0])
  })

  test("should lazily create policy state for an active SFU call during the periodic sweep", async () => {
    const s = await scenario(1, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: false,
      turnConfigured: true,
    })
    await pool.query(`DELETE FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`, [
      s.workspaceId,
      started.call.id,
    ])
    await FeatureFlagOverrideRepository.replaceForSubject(pool, s.workspaceId, "workspace", s.workspaceId, {
      callsP2p: "on",
    })

    await service.sweepTransportPolicy(new Date())
    const state = await pool.query(
      `SELECT desired_transport, eligibility_deadline, eligibility_generation FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    expect({
      desiredTransport: state.rows[0]?.desired_transport,
      hasDeadline: state.rows[0]?.eligibility_deadline instanceof Date,
      eligibilityGeneration: state.rows[0]?.eligibility_generation,
    }).toEqual({ desiredTransport: "p2p", hasDeadline: true, eligibilityGeneration: 1 })
  })

  test("should arm an SFU deadline after enrollment or TURN capability is restored without membership changes", async () => {
    const enrollment = await scenario(1, false)
    const withoutTurn = await scenario(1, true)
    const unavailableService = new CallService({ pool, featureFlagService: featureFlags })
    const enrollmentCall = await unavailableService.startCall({
      ...admission(enrollment.workspaceId, "", enrollment.userIds[0]!, 0),
      streamId: enrollment.streamId,
      mode: "video",
      callsP2pEnabled: false,
      turnConfigured: false,
    })
    const turnCall = await unavailableService.startCall({
      ...admission(withoutTurn.workspaceId, "", withoutTurn.userIds[0]!, 0),
      streamId: withoutTurn.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: false,
    })
    await FeatureFlagOverrideRepository.replaceForSubject(
      pool,
      enrollment.workspaceId,
      "workspace",
      enrollment.workspaceId,
      {
        callsP2p: "on",
      }
    )

    const restarted = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    await restarted.sweepTransportPolicy(new Date())

    const states = await pool.query(
      `SELECT workspace_id, desired_transport, eligibility_deadline, eligibility_generation, version
       FROM call_transport_policy_states
       WHERE (workspace_id = $1 AND call_id = $2) OR (workspace_id = $3 AND call_id = $4)
       ORDER BY workspace_id`,
      [enrollment.workspaceId, enrollmentCall.call.id, withoutTurn.workspaceId, turnCall.call.id]
    )
    expect(
      states.rows.map((row) => ({
        workspaceId: row.workspace_id,
        desiredTransport: row.desired_transport,
        hasDeadline: row.eligibility_deadline instanceof Date,
        eligibilityGeneration: row.eligibility_generation,
      }))
    ).toEqual(
      [enrollment.workspaceId, withoutTurn.workspaceId]
        .sort()
        .map((workspaceId) => ({ workspaceId, desiredTransport: "p2p", hasDeadline: true, eligibilityGeneration: 1 }))
    )

    await restarted.sweepTransportPolicy(new Date())
    expect(
      (
        await pool.query(
          `SELECT workspace_id, eligibility_deadline, eligibility_generation, version
           FROM call_transport_policy_states
           WHERE (workspace_id = $1 AND call_id = $2) OR (workspace_id = $3 AND call_id = $4)
           ORDER BY workspace_id`,
          [enrollment.workspaceId, enrollmentCall.call.id, withoutTurn.workspaceId, turnCall.call.id]
        )
      ).rows
    ).toEqual(
      states.rows.map(({ workspace_id, eligibility_deadline, eligibility_generation, version }) => ({
        workspace_id,
        eligibility_deadline,
        eligibility_generation,
        version,
      }))
    )
  })

  test("should not infer TURN configuration from the legacy enrollment parameter", async () => {
    const s = await scenario(1, true)
    const service = new CallService({ pool, featureFlagService: featureFlags })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
    })
    expect(started.call.mediaTransport).toBe("sfu")
  })

  test("should enforce the product cap at 50 on SFU instead of treating seven as full", async () => {
    const s = await scenario(51, false)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: false,
      turnConfigured: true,
    })
    for (let index = 1; index < 50; index++) {
      await service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[index]!, index))
    }

    await expect(service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[50]!, 50))).rejects.toMatchObject(
      {
        code: "CALL_FULL",
      }
    )
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM call_endpoints WHERE workspace_id = $1 AND call_id = $2 AND status IN ('connected','reconnecting')`,
          [s.workspaceId, started.call.id]
        )
      ).rows[0]
    ).toEqual({ count: 50 })
  })

  test("should preserve explicit holds at six and seven and let rollout safety override P2P", async () => {
    const atSeven = await scenario(7, false)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const seven = await service.startCall({
      ...admission(atSeven.workspaceId, "", atSeven.userIds[0]!, 0),
      streamId: atSeven.streamId,
      mode: "video",
      callsP2pEnabled: false,
      turnConfigured: true,
    })
    for (let index = 1; index < 7; index++)
      await service.joinCall(admission(atSeven.workspaceId, seven.call.id, atSeven.userIds[index]!, index))
    await FeatureFlagOverrideRepository.replaceForSubject(pool, atSeven.workspaceId, "workspace", atSeven.workspaceId, {
      callsP2p: "on",
    })
    await service.requestTransportTransfer({
      workspaceId: atSeven.workspaceId,
      callId: seven.call.id,
      userId: atSeven.userIds[0]!,
      endpointId: seven.endpoint.id,
      target: "p2p",
      idempotencyKey: "explicit-p2p-at-seven",
    })
    expect(
      (
        await pool.query(
          `SELECT explicit_hold_target, explicit_hold_admitted_count FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
          [atSeven.workspaceId, seven.call.id]
        )
      ).rows[0]
    ).toEqual({ explicit_hold_target: "p2p", explicit_hold_admitted_count: 7 })

    const atSix = await scenario(6, true)
    const six = await service.startCall({
      ...admission(atSix.workspaceId, "", atSix.userIds[0]!, 0),
      streamId: atSix.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    for (let index = 1; index < 6; index++)
      await service.joinCall(admission(atSix.workspaceId, six.call.id, atSix.userIds[index]!, index))
    await service.requestTransportTransfer({
      workspaceId: atSix.workspaceId,
      callId: six.call.id,
      userId: atSix.userIds[0]!,
      endpointId: six.endpoint.id,
      target: "sfu",
      idempotencyKey: "explicit-sfu-at-six",
    })
    expect(
      (
        await pool.query(
          `SELECT explicit_hold_target, explicit_hold_admitted_count FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
          [atSix.workspaceId, six.call.id]
        )
      ).rows[0]
    ).toEqual({ explicit_hold_target: "sfu", explicit_hold_admitted_count: 6 })

    const transfer = await pool.query(
      `SELECT id, target_generation FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2`,
      [atSeven.workspaceId, seven.call.id]
    )
    await pool.query(
      `UPDATE calls SET media_transport = 'p2p', transport_generation = $3 WHERE workspace_id = $1 AND id = $2`,
      [atSeven.workspaceId, seven.call.id, transfer.rows[0].target_generation]
    )
    await pool.query(`UPDATE call_transport_transfers SET phase = 'completed' WHERE workspace_id = $1 AND id = $2`, [
      atSeven.workspaceId,
      transfer.rows[0].id,
    ])
    await FeatureFlagOverrideRepository.replaceForSubject(pool, atSeven.workspaceId, "workspace", atSeven.workspaceId, {
      callsP2p: "off",
    })
    await service.joinCall({
      ...admission(atSeven.workspaceId, seven.call.id, atSeven.userIds[0]!, 99),
      takeover: true,
    })
    expect(
      (
        await pool.query(
          `SELECT desired_transport, explicit_hold_target, latest_reason FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
          [atSeven.workspaceId, seven.call.id]
        )
      ).rows[0]
    ).toEqual({ desired_transport: "sfu", explicit_hold_target: null, latest_reason: "rollout_flag_off" })
  })

  test("should preserve a 30-second deadline across restart and fence stale deadline identities", async () => {
    const s = await scenario(7, false)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: false,
      turnConfigured: true,
    })
    const endpoints = [started.endpoint]
    for (let index = 1; index < 7; index++)
      endpoints.push(
        await service
          .joinCall(admission(s.workspaceId, started.call.id, s.userIds[index]!, index))
          .then((r) => r.endpoint)
      )
    await FeatureFlagOverrideRepository.replaceForSubject(pool, s.workspaceId, "workspace", s.workspaceId, {
      callsP2p: "on",
    })
    const before = new Date()
    await service.leaveCall({
      workspaceId: s.workspaceId,
      callId: started.call.id,
      userId: s.userIds[6]!,
      endpointId: endpoints[6]!.id,
    })
    const armed = await pool.query(
      `SELECT eligibility_deadline, eligibility_generation, source_transport_generation, version
       FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    const deadline = new Date(armed.rows[0].eligibility_deadline)
    expect(deadline.getTime() - before.getTime()).toBeGreaterThanOrEqual(29_000)
    expect(deadline.getTime() - before.getTime()).toBeLessThanOrEqual(31_000)

    const restarted = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    await restarted.sweepTransportPolicy(new Date(deadline.getTime() - 1))
    expect(
      (
        await pool.query(`SELECT count(*)::int AS count FROM call_transport_transfers WHERE call_id = $1`, [
          started.call.id,
        ])
      ).rows[0]
    ).toEqual({ count: 0 })
    await restarted.sweepTransportPolicy(deadline)
    expect(
      (
        await pool.query(`SELECT cause, actor_type, requested_by FROM call_transport_transfers WHERE call_id = $1`, [
          started.call.id,
        ])
      ).rows
    ).toEqual([{ cause: "automatic_threshold", actor_type: "system", requested_by: null }])

    await pool.query(
      `UPDATE call_transport_policy_states SET eligibility_deadline = NOW() - INTERVAL '1 second', eligibility_generation = eligibility_generation + 1, version = version + 1 WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    await restarted.sweepTransportPolicy(deadline)
    expect(
      (
        await pool.query(`SELECT count(*)::int AS count FROM call_transport_transfers WHERE call_id = $1`, [
          started.call.id,
        ])
      ).rows[0]
    ).toEqual({ count: 1 })
  })

  test("should reconcile removal, takeover, and lease reap without resetting an armed deadline", async () => {
    const s = await scenario(7, false)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: false,
      turnConfigured: true,
    })
    const endpoints = [started.endpoint]
    for (let index = 1; index < 7; index++)
      endpoints.push(
        await service
          .joinCall(admission(s.workspaceId, started.call.id, s.userIds[index]!, index))
          .then((r) => r.endpoint)
      )
    await FeatureFlagOverrideRepository.replaceForSubject(pool, s.workspaceId, "workspace", s.workspaceId, {
      callsP2p: "on",
    })

    await service.removeParticipant({
      workspaceId: s.workspaceId,
      callId: started.call.id,
      byUserId: s.userIds[0]!,
      targetUserId: s.userIds[6]!,
    })
    const armed = await pool.query(
      `SELECT admitted_count, eligibility_deadline, eligibility_generation FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    expect({
      ...armed.rows[0],
      eligibility_deadline: new Date(armed.rows[0].eligibility_deadline).toISOString(),
    }).toEqual({
      admitted_count: 6,
      eligibility_deadline: new Date(armed.rows[0].eligibility_deadline).toISOString(),
      eligibility_generation: 1,
    })

    await service.joinCall({ ...admission(s.workspaceId, started.call.id, s.userIds[0]!, 70), takeover: true })
    const afterTakeover = await pool.query(
      `SELECT admitted_count, eligibility_deadline, eligibility_generation FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    expect(afterTakeover.rows[0]).toEqual(armed.rows[0])

    const reapAt = new Date()
    await pool.query(`UPDATE call_endpoints SET lease_expires_at = $3 WHERE workspace_id = $1 AND id = $2`, [
      s.workspaceId,
      endpoints[1]!.id,
      reapAt,
    ])
    await service.reapLapsedEndpoints(reapAt)
    const afterReap = await pool.query(
      `SELECT admitted_count, eligibility_deadline, eligibility_generation FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    expect(afterReap.rows[0]).toEqual({
      admitted_count: 5,
      eligibility_deadline: armed.rows[0].eligibility_deadline,
      eligibility_generation: 1,
    })
  })

  test("should clear policy state for an ended zero-endpoint call without creating a transfer", async () => {
    const s = await scenario(1, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    await pool.query(
      `UPDATE call_transport_policy_states SET eligibility_deadline = NOW() - INTERVAL '1 second', eligibility_generation = 4, explicit_hold_target = 'p2p', explicit_hold_admitted_count = 1 WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    await service.leaveCall({
      workspaceId: s.workspaceId,
      callId: started.call.id,
      userId: s.userIds[0]!,
      endpointId: started.endpoint.id,
    })

    expect(
      (
        await pool.query(
          `SELECT admitted_count, eligibility_deadline, eligibility_generation, explicit_hold_target, latest_reason FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
          [s.workspaceId, started.call.id]
        )
      ).rows[0]
    ).toEqual({
      admitted_count: 0,
      eligibility_deadline: null,
      eligibility_generation: 0,
      explicit_hold_target: null,
      latest_reason: "call_empty_or_ended",
    })
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2`,
          [s.workspaceId, started.call.id]
        )
      ).rows[0]
    ).toEqual({ count: 0 })
  })

  test("should keep transfer-only SFU endpoints ineligible for P2P while allowing them to coordinate an SFU escape", async () => {
    const sfuScenario = await scenario(1, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const sfu = await service.startCall({
      ...admission(sfuScenario.workspaceId, "", sfuScenario.userIds[0]!, 0),
      transportCapability: undefined,
      streamId: sfuScenario.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    await service.sweepTransportPolicy(new Date())
    expect(
      (
        await pool.query(
          `SELECT desired_transport, eligibility_deadline, latest_reason FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
          [sfuScenario.workspaceId, sfu.call.id]
        )
      ).rows[0]
    ).toEqual({ desired_transport: "sfu", eligibility_deadline: null, latest_reason: "rollout_capability_missing" })

    const p2pScenario = await scenario(1, true)
    const p2p = await service.startCall({
      ...admission(p2pScenario.workspaceId, "", p2pScenario.userIds[0]!, 0),
      streamId: p2pScenario.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    await pool.query(`UPDATE call_endpoints SET transport_capability = NULL WHERE workspace_id = $1 AND id = $2`, [
      p2pScenario.workspaceId,
      p2p.endpoint.id,
    ])
    await service.sweepTransportPolicy(new Date())
    expect(
      (
        await pool.query(
          `SELECT target_transport, cause FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2`,
          [p2pScenario.workspaceId, p2p.call.id]
        )
      ).rows
    ).toEqual([{ target_transport: "sfu", cause: "rollout_safety" }])
  })

  test("should reject impossible explicit P2P targets before transfer or policy hold writes", async () => {
    for (const unavailable of ["turn", "endpoint"] as const) {
      const s = await scenario(1, true)
      const service = new CallService({
        pool,
        featureFlagService: featureFlags,
        turnIssuer: unavailable === "turn" ? undefined : turnIssuer,
      })
      const started = await service.startCall({
        ...admission(s.workspaceId, "", s.userIds[0]!, 0),
        transportCapability: unavailable === "endpoint" ? undefined : "p2p-v1",
        streamId: s.streamId,
        mode: "video",
        callsP2pEnabled: false,
        turnConfigured: unavailable !== "turn",
      })
      await expect(
        service.requestTransportTransfer({
          workspaceId: s.workspaceId,
          callId: started.call.id,
          userId: s.userIds[0]!,
          endpointId: started.endpoint.id,
          target: "p2p",
          idempotencyKey: `impossible-${unavailable}`,
        })
      ).rejects.toMatchObject({
        code: unavailable === "turn" ? "CALL_TURN_UNAVAILABLE" : "CALL_P2P_CAPABILITY_REQUIRED",
      })
      expect(
        (
          await pool.query(
            `SELECT
               (SELECT count(*)::int FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2) AS transfers,
               (SELECT explicit_hold_target FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2) AS hold`,
            [s.workspaceId, started.call.id]
          )
        ).rows[0]
      ).toEqual({ transfers: 0, hold: null })
    }
  })

  test("should allow explicit SFU transfer with transfer-only coordination and omit unknown actor provenance", async () => {
    const s = await scenario(1, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    await pool.query(`UPDATE call_endpoints SET transport_capability = NULL WHERE workspace_id = $1 AND id = $2`, [
      s.workspaceId,
      started.endpoint.id,
    ])
    await service.requestTransportTransfer({
      workspaceId: s.workspaceId,
      callId: started.call.id,
      userId: s.userIds[0]!,
      endpointId: started.endpoint.id,
      target: "sfu",
      idempotencyKey: "transfer-only-sfu",
    })
    await pool.query(
      `UPDATE call_transport_transfers SET actor_type = NULL, actor_endpoint_id = NULL WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    const snapshot = await service.getRosterSnapshot(s.workspaceId, started.call.id)
    expect({ target: snapshot.transfer?.target.transport, actor: snapshot.transfer?.actor }).toEqual({
      target: "sfu",
      actor: undefined,
    })
  })

  test("should reject a removed SFU-only caller before transport side effects", async () => {
    const s = await scenario(7, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    for (let index = 1; index < 6; index++)
      await service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[index]!, index))
    await pool.query(
      `INSERT INTO call_participants (id, workspace_id, call_id, user_id, status, removed_by)
       VALUES ($1, $2, $3, $4, 'removed', $5)`,
      [`callpart_removed_${s.workspaceId}`, s.workspaceId, started.call.id, s.userIds[6]!, s.userIds[0]!]
    )

    await expect(
      service.joinCall({
        ...admission(s.workspaceId, started.call.id, s.userIds[6]!, 60),
        transportCapability: undefined,
      })
    ).rejects.toMatchObject({ code: "CALL_PARTICIPANT_REMOVED" })
    expect(
      (
        await pool.query(
          `SELECT
             (SELECT count(*)::int FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2) AS transfers,
             (SELECT count(*)::int FROM outbox WHERE event_type = 'call:transport_transfer_changed' AND payload->>'callId' = $2) AS events`,
          [s.workspaceId, started.call.id]
        )
      ).rows[0]
    ).toEqual({ transfers: 0, events: 0 })
  })

  test("should reject caller 51 before overriding an explicit P2P hold", async () => {
    const s = await scenario(51, false)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: false,
      turnConfigured: true,
    })
    for (let index = 1; index < 50; index++)
      await service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[index]!, index))
    await pool.query(`UPDATE calls SET media_transport = 'p2p' WHERE workspace_id = $1 AND id = $2`, [
      s.workspaceId,
      started.call.id,
    ])
    await pool.query(
      `UPDATE call_transport_policy_states
       SET explicit_hold_target = 'p2p', explicit_hold_admitted_count = 50
       WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )

    await expect(service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[50]!, 50))).rejects.toMatchObject(
      {
        code: "CALL_FULL",
      }
    )
    expect(
      (
        await pool.query(
          `SELECT
             (SELECT count(*)::int FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2) AS transfers,
             (SELECT count(*)::int FROM outbox WHERE event_type = 'call:transport_transfer_changed' AND payload->>'callId' = $2) AS events,
             (SELECT explicit_hold_target FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2) AS hold`,
          [s.workspaceId, started.call.id]
        )
      ).rows[0]
    ).toEqual({ transfers: 0, events: 0, hold: "p2p" })
  })

  test("should reject an unauthorized SFU-only second endpoint before transport side effects", async () => {
    const s = await scenario(1, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })

    await expect(
      service.joinCall({
        ...admission(s.workspaceId, started.call.id, s.userIds[0]!, 1),
        transportCapability: undefined,
      })
    ).rejects.toMatchObject({ code: "CALL_ENDPOINT_ACTIVE" })
    expect(
      (
        await pool.query(
          `SELECT
             (SELECT count(*)::int FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2) AS transfers,
             (SELECT count(*)::int FROM outbox WHERE event_type = 'call:transport_transfer_changed' AND payload->>'callId' = $2) AS events`,
          [s.workspaceId, started.call.id]
        )
      ).rows[0]
    ).toEqual({ transfers: 0, events: 0 })
  })

  test("should prepare SFU before an SFU-only same-user takeover without closing the incumbent", async () => {
    const s = await scenario(1, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })

    await expect(
      service.joinCall({
        ...admission(s.workspaceId, started.call.id, s.userIds[0]!, 1),
        transportCapability: undefined,
        takeover: true,
      })
    ).rejects.toMatchObject({ code: "CALL_TRANSPORT_PREPARING" })
    expect(
      (
        await pool.query(
          `SELECT
             (SELECT status FROM call_endpoints WHERE workspace_id = $1 AND id = $3) AS incumbent_status,
             (SELECT count(*)::int FROM call_endpoints WHERE workspace_id = $1 AND call_id = $2 AND status IN ('connected','reconnecting')) AS endpoints,
             (SELECT count(*)::int FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2 AND target_transport = 'sfu') AS transfers`,
          [s.workspaceId, started.call.id, started.endpoint.id]
        )
      ).rows[0]
    ).toEqual({ incumbent_status: "connected", endpoints: 1, transfers: 1 })
  })

  test("should replace a capable endpoint at six without treating the takeover as seventh admission", async () => {
    const s = await scenario(6, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    for (let index = 1; index < 6; index++)
      await service.joinCall(admission(s.workspaceId, started.call.id, s.userIds[index]!, index))

    const takeover = await service.joinCall({
      ...admission(s.workspaceId, started.call.id, s.userIds[0]!, 6),
      takeover: true,
    })
    expect({ supersededEndpointId: takeover.supersededEndpointId, endpointId: takeover.endpoint.id }).toEqual({
      supersededEndpointId: started.endpoint.id,
      endpointId: takeover.endpoint.id,
    })
    expect(
      (
        await pool.query(
          `SELECT
             (SELECT count(*)::int FROM call_endpoints WHERE workspace_id = $1 AND call_id = $2 AND status IN ('connected','reconnecting')) AS endpoints,
             (SELECT count(*)::int FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2) AS transfers`,
          [s.workspaceId, started.call.id]
        )
      ).rows[0]
    ).toEqual({ endpoints: 6, transfers: 0 })
  })

  test("should count reconnecting leases at the exact expiry boundary and leave manual holds unchanged by media churn", async () => {
    const s = await scenario(1, true)
    const service = new CallService({ pool, featureFlagService: featureFlags, turnIssuer })
    const started = await service.startCall({
      ...admission(s.workspaceId, "", s.userIds[0]!, 0),
      streamId: s.streamId,
      mode: "video",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    const expiry = new Date(Date.now() + 5_000)
    await pool.query(
      `UPDATE call_endpoints SET status = 'reconnecting', lease_expires_at = $3 WHERE workspace_id = $1 AND id = $2`,
      [s.workspaceId, started.endpoint.id, expiry]
    )
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM call_endpoints WHERE call_id = $1 AND status IN ('connected','reconnecting') AND lease_expires_at > $2`,
          [started.call.id, new Date(expiry.getTime() - 1)]
        )
      ).rows[0]
    ).toEqual({ count: 1 })
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM call_endpoints WHERE call_id = $1 AND status IN ('connected','reconnecting') AND lease_expires_at > $2`,
          [started.call.id, expiry]
        )
      ).rows[0]
    ).toEqual({ count: 0 })

    await pool.query(
      `UPDATE call_transport_policy_states SET explicit_hold_target = 'p2p', explicit_hold_admitted_count = 1 WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    await pool.query(
      `UPDATE call_endpoints SET lease_expires_at = NOW() + INTERVAL '1 minute' WHERE workspace_id = $1 AND id = $2`,
      [s.workspaceId, started.endpoint.id]
    )
    await service.setEndpointMediaState({
      workspaceId: s.workspaceId,
      callId: started.call.id,
      userId: s.userIds[0]!,
      endpointId: started.endpoint.id,
      mediaIncarnation: "inc_0",
      mediaState: { muted: true },
    })
    const hold = await pool.query(
      `SELECT explicit_hold_target, explicit_hold_admitted_count FROM call_transport_policy_states WHERE workspace_id = $1 AND call_id = $2`,
      [s.workspaceId, started.call.id]
    )
    expect(hold.rows[0]).toEqual({ explicit_hold_target: "p2p", explicit_hold_admitted_count: 1 })
  })
})
