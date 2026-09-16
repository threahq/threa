import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { AI_SPENDING_COVERAGE, AuthorTypes } from "@threahq/types"
import { createWebSearchTool } from "@threahq/agent-runtime"
import {
  AISpendingJobAdmission,
  AISpendingService,
  SpendPolicyRepository,
  provisionUnprotectedSpendingPolicies,
} from "../../src/features/ai-usage"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import {
  E2eStreamsRepository,
  E2eStreamActorsRepository,
  StreamE2eKeyWrapsRepository,
} from "../../src/features/e2e-streams"
import { EnclaveClaimService, EnclaveInvocationsRepository } from "../../src/features/enclave-runtimes"
import { EventService } from "../../src/features/messaging"
import { UserPreferencesService } from "../../src/features/user-preferences"
import { VoiceTranscriptionService } from "../../src/features/voice-transcription"
import type { StorageProvider } from "../../src/lib/storage/s3-client"
import { QueueManager, QueueRepository, TokenPoolRepository, JobQueues } from "../../src/lib/queue"
import { workspaceId, userId, streamId, enclaveInvocationId, queueId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let spending: AISpendingService
beforeAll(async () => {
  const isolated = await setupIsolatedTestDatabase("ai-spending-unsupported-paths")
  pool = isolated.pool
  cleanup = isolated.cleanup
  spending = new AISpendingService({ pool })
})
afterAll(async () => cleanup())

async function fixture(provision = true) {
  const workspace = workspaceId()
  const identity = userId()
  await WorkspaceRepository.insert(pool, { id: workspace, name: "Spending", slug: workspace, createdBy: identity })
  const user = await addTestMember(pool, workspace, identity)
  if (provision) await SpendPolicyRepository.insertUnprotected(pool, [workspace])
  return { workspace, user }
}

async function enforce(workspace: string) {
  const policy = await spending.getPolicy(workspace)
  await spending.setPolicy({
    workspaceId: workspace,
    expectedVersion: policy!.version,
    operatorWorkosUserId: "operator_test",
    status: "enforced",
    coverageProfile: AI_SPENDING_COVERAGE.profile,
    limits: {
      agentCutoffUsd: "5",
      enrichmentCutoffUsd: "5",
      coreCutoffUsd: "5",
      embeddingCutoffUsd: "5",
      operatorCeilingUsd: "5",
    },
  })
}

test("should preserve unsupported background work without entering its handler or retrying", async () => {
  const { workspace } = await fixture()
  await enforce(workspace)
  const manager = new QueueManager({
    pool,
    queueRepository: QueueRepository,
    tokenPoolRepository: TokenPoolRepository,
    admission: new AISpendingJobAdmission(spending),
    pollIntervalMs: 20,
    maxRetries: 1,
  })
  let executions = 0
  manager.registerHandler(JobQueues.MEMO_BATCH_PROCESS, async () => {
    executions++
  })
  const id = queueId()
  const source = { workspaceId: workspace, streamId: streamId() }
  await manager.start()
  try {
    await manager.send(JobQueues.MEMO_BATCH_PROCESS, source, { messageId: id })
    let paused = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !paused) {
      const result = await pool.query("SELECT paused_reason FROM queue_messages WHERE workspace_id=$1 AND id=$2", [
        workspace,
        id,
      ])
      paused = result.rows[0]?.paused_reason !== null && result.rows[0]?.paused_reason !== undefined
      if (!paused) await Bun.sleep(20)
    }
    expect(paused).toBe(true)
    await withTransaction(pool, (db) => provisionUnprotectedSpendingPolicies(db, [workspace]))
    await Bun.sleep(100)
    const result = await pool.query(
      "SELECT payload, paused_reason, failed_count, completed_at, dlq_at, process_after, claimed_count FROM queue_messages WHERE workspace_id=$1 AND id=$2",
      [workspace, id]
    )
    expect({ executions, rows: result.rows }).toEqual({
      executions: 0,
      rows: [
        {
          payload: source,
          paused_reason: "ai-spending:UNSUPPORTED_OPERATION",
          failed_count: 0,
          completed_at: null,
          dlq_at: null,
          process_after: null,
          claimed_count: 1,
        },
      ],
    })
  } finally {
    await manager.stop()
  }
})

test("should wake preserved work when policy provisioning establishes explicit unprotected mode", async () => {
  const { workspace } = await fixture(false)
  const manager = new QueueManager({
    pool,
    queueRepository: QueueRepository,
    tokenPoolRepository: TokenPoolRepository,
    admission: new AISpendingJobAdmission(spending),
    pollIntervalMs: 20,
    maxRetries: 1,
  })
  const completed = Promise.withResolvers<void>()
  let executions = 0
  manager.registerHandler(JobQueues.MEMO_BATCH_PROCESS, async () => {
    executions++
    completed.resolve()
  })
  const id = queueId()
  await manager.start()
  try {
    await manager.send(
      JobQueues.MEMO_BATCH_PROCESS,
      { workspaceId: workspace, streamId: streamId() },
      { messageId: id }
    )
    let reason: string | null = null
    const deadline = Date.now() + 5000
    while (!reason && Date.now() < deadline) {
      reason = (
        await pool.query("SELECT paused_reason FROM queue_messages WHERE workspace_id=$1 AND id=$2", [workspace, id])
      ).rows[0]?.paused_reason
      if (!reason) await Bun.sleep(20)
    }
    expect(reason).toBe("ai-spending:NOT_PROVISIONED")
    await withTransaction(pool, (db) => provisionUnprotectedSpendingPolicies(db, [workspace]))
    await Promise.race([
      completed.promise,
      Bun.sleep(5000).then(() => {
        throw new Error("Preserved work did not resume")
      }),
    ])
    expect(executions).toBe(1)
    const resumed = await pool.query(
      "SELECT paused_reason, failed_count FROM queue_messages WHERE workspace_id=$1 AND id=$2",
      [workspace, id]
    )
    expect(resumed.rows).toEqual([{ paused_reason: null, failed_count: 0 }])
  } finally {
    await manager.stop()
  }
})

test("should refuse unsupported voice creation and a pre-enrollment session's relay", async () => {
  const { workspace, user } = await fixture()
  const voice = new VoiceTranscriptionService(pool, new UserPreferencesService(pool), spending)
  const created = await voice.createSession({ workspaceId: workspace, userId: user.id })
  await enforce(workspace)
  await expect(voice.createSession({ workspaceId: workspace, userId: user.id })).rejects.toMatchObject({
    code: "UNSUPPORTED_OPERATION",
  })
  await expect(
    voice.getRelaySession({ workspaceId: workspace, workosUserId: user.workosUserId, sessionId: created.id })
  ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" })
})

test("should deny Tavily before HTTP for an enforced workspace", async () => {
  const { workspace } = await fixture()
  await enforce(workspace)
  const failFetch = Object.assign(
    async () => {
      throw new Error("Unexpected provider egress")
    },
    { preconnect: globalThis.fetch.preconnect }
  )
  const fetch = spyOn(globalThis, "fetch").mockImplementation(failFetch)
  try {
    const tool = createWebSearchTool({
      tavilyApiKey: "test-only",
      beforeRequest: () => spending.assertUnprotected(workspace),
    })
    await expect(tool.config.execute({ query: "test" }, { toolCallId: "test" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    })
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
  }
})

test("should publish a durable encrypted-assistant stop without handing ciphertext to a runner", async () => {
  const { workspace, user } = await fixture()
  const target = streamId()
  await StreamRepository.insert(pool, {
    id: target,
    workspaceId: workspace,
    type: "channel",
    visibility: "private",
    companionMode: "off",
    createdBy: user.id,
  })
  await StreamMemberRepository.insert(pool, target, user.id)
  await E2eStreamsRepository.markStreamE2e(pool, {
    streamId: target,
    workspaceId: workspace,
    ownerUserId: user.id,
    ownerUserKeyId: "ukey_test",
    currentKeyGeneration: 1,
  })
  await E2eStreamActorsRepository.add(pool, workspace, target, "enclave", "enclave", null)
  const trigger = (
    await new EventService(pool).createMessageForPrincipalReturningConversation(
      { kind: "user", userId: user.id },
      {
        workspaceId: workspace,
        streamId: target,
        authorId: user.id,
        authorType: AuthorTypes.USER,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "",
        ciphertext: Buffer.from("sealed test input"),
        envelope: { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" },
        e2eVersion: 2,
      }
    )
  ).message
  const keyId = `eik_${target}`
  await StreamE2eKeyWrapsRepository.insertMany(pool, [
    {
      workspaceId: workspace,
      streamId: target,
      keyGeneration: 1,
      recipientKeyId: keyId,
      recipientKind: "enclave",
      wrapEnc: "ZW5j",
      wrapCt: "Y3Q=",
    },
  ])
  const id = enclaveInvocationId()
  await EnclaveInvocationsRepository.insertPending(pool, {
    id,
    workspaceId: workspace,
    streamId: target,
    rootStreamId: target,
    messageId: trigger.id,
    triggeredBy: user.id,
  })
  await enforce(workspace)
  let reads = 0
  const storageCall = async (): Promise<never> => {
    reads++
    throw new Error("Unexpected ciphertext storage access")
  }
  const storage: StorageProvider = {
    getObject: storageCall,
    getObjectSize: storageCall,
    getObjectStat: storageCall,
    getSignedDownloadUrl: storageCall,
    getObjectRange: storageCall,
    getObjectStream: storageCall,
    getObjectContent: storageCall,
    putObject: storageCall,
    copyObject: storageCall,
    delete: storageCall,
  }
  const service = new EnclaveClaimService({
    pool,
    spendingPolicy: spending,
    userPreferencesService: new UserPreferencesService(pool),
    storage,
  })
  expect(await service.claimTurn(keyId)).toBeNull()
  expect(await service.claimTurn(keyId)).toBeNull()
  expect(reads).toBe(0)
  const invocation = await pool.query(
    "SELECT status, error_message FROM enclave_invocations WHERE workspace_id=$1 AND id=$2",
    [workspace, id]
  )
  expect(invocation.rows).toEqual([{ status: "failed", error_message: "AI_SPENDING_DENIED:UNSUPPORTED_OPERATION" }])
  const session = await pool.query(
    "SELECT status, stop_reason, initiating_user_id FROM agent_sessions WHERE stream_id=$1 AND trigger_message_id=$2",
    [target, trigger.id]
  )
  expect(session.rows).toEqual([{ status: "failed", stop_reason: "spending_denied", initiating_user_id: user.id }])
  const event = await pool.query(
    "SELECT payload FROM stream_events WHERE stream_id=$1 AND event_type='agent_session:failed'",
    [target]
  )
  expect(event.rows).toEqual([
    {
      payload: expect.objectContaining({ spendingStop: { reason: "spending_denied", code: "UNSUPPORTED_OPERATION" } }),
    },
  ])
})
