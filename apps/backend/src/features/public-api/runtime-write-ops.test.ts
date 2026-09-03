import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import * as agentRuntime from "@threa/agent-runtime"
import { createBotRuntimeWriteOps } from "./runtime-write-ops"
import * as e2eStreams from "../e2e-streams"
import { E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../e2e-streams"
import { BotRuntimeInstanceRepository, type BotInvocation, type BotRuntimeService } from "../bot-runtimes"
import { MessageRepository } from "../messaging"
import { AgentSessionRepository } from "../agents"
import { BotChannelAccessRepository } from "../api-keys"

function invocation(overrides: Partial<BotInvocation> = {}): BotInvocation {
  return {
    id: "binv_1",
    workspaceId: "ws_1",
    rootStreamId: "stream_root",
    activeStreamId: "stream_active",
    sourceMessageId: "msg_1",
    responseStreamId: "stream_active",
    actorType: "bot",
    actorId: "bot_1",
    trigger: "active-scratchpad",
    requiredCapability: "active-scratchpad",
    promptMarkdown: "revision two",
    sourceMessageRevision: 2,
    claimedSourceMessageRevision: 1,
    claimedInputUpdateMode: "live",
    cancellationReason: null,
    authorUserId: "usr_1",
    mentionedActorSlugs: [],
    status: "claimed",
    targetInstanceId: null,
    targetRuntimeSessionId: null,
    claimedByInstanceId: "inst_1",
    claimedRuntimeSessionId: null,
    claimedRuntimeSessionClaimToken: null,
    claimToken: "tok_1",
    claimExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    attempts: 1,
    errorMessage: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  }
}

function setup(serviceOverrides: Partial<BotRuntimeService> = {}) {
  const queries: string[] = []
  const client = {
    query: mock(async (query: string) => {
      queries.push(query)
      return { rows: [] }
    }),
    release: mock(() => {}),
  } as unknown as PoolClient
  const connect = mock(async () => client)
  const pool = { connect } as unknown as Pool
  const service = {
    renewInvocationClaimInTransaction: mock(async () => invocation()),
    cancelOwnedClaimForKeyGrantLossInTransaction: mock(async () =>
      invocation({ status: "cancelled", cancellationReason: "key_grant_lost" })
    ),
    upsertPresenceFromBotKey: mock(async () => ({
      ...invocation(),
      botId: "bot_1",
      runtimeKind: "openclaw",
      instanceId: "inst_1",
      displayName: null,
      status: "available",
      acceptingInvocations: true,
      capabilities: {},
      manifest: { output: {}, input: { updates: "live" } },
      statusText: null,
      publicKey: null,
      publicKeyId: null,
      lastSeenAt: new Date(),
    })),
    ...serviceOverrides,
  } as unknown as BotRuntimeService
  spyOn(AgentSessionRepository, "updateHeartbeat").mockResolvedValue(undefined as never)
  spyOn(AgentSessionRepository, "updateInvocationReplyKeyGeneration").mockResolvedValue(true)
  return {
    client,
    connect,
    pool,
    queries,
    service,
    ops: createBotRuntimeWriteOps({
      pool,
      io: {} as never,
      botRuntimeService: service,
      botChannelService: {} as never,
    }),
  }
}

const params = {
  workspaceId: "ws_1",
  botId: "bot_1",
  invocationId: "binv_1",
  instanceId: "inst_1",
  claimToken: "tok_1",
  claimTtlSeconds: 60,
  knownSourceRevision: 1,
}

describe("runtime renew control snapshot", () => {
  afterEach(() => mock.restore())

  it("retries serialization failures with a rolled-back fresh transaction only", async () => {
    const serializationFailure = Object.assign(new Error("serialization failure"), { code: "40001" })
    const arbitraryFailure = Object.assign(new Error("arbitrary failure"), { code: "XX000" })
    const renew = mock(async () => {
      if (renew.mock.calls.length === 1) throw serializationFailure
      return invocation()
    })
    const { ops, connect, queries } = setup({ renewInvocationClaimInTransaction: renew })
    spyOn(e2eStreams, "resolveSealingContext").mockResolvedValue({
      streamIsE2e: false,
      actorHasGrant: false,
      externalSealedDelivery: false,
    })
    spyOn(agentRuntime, "resolveDeliveryVerdict").mockReturnValue({ delivery: "plaintext" })

    await expect(ops.renewClaim(params)).resolves.toMatchObject({ status: "active" })
    expect({
      connections: connect.mock.calls.length,
      rollbacks: queries.filter((query) => query === "ROLLBACK"),
    }).toEqual({
      connections: 2,
      rollbacks: ["ROLLBACK"],
    })

    renew.mockImplementation(async () => {
      throw arbitraryFailure
    })
    const connectionsBefore = connect.mock.calls.length
    await expect(ops.renewClaim(params)).rejects.toBe(arbitraryFailure)
    expect(connect.mock.calls.length - connectionsBefore).toBe(1)
  })

  it("plumbs HTTP presence manifest to explicit registration", async () => {
    spyOn(BotChannelAccessRepository, "getGrantedStreamIds").mockResolvedValue([])
    const { ops, service } = setup()
    const manifest = {
      output: { reply: true, trace: true, sources: false },
      input: { updates: "live" as const },
    }

    await ops.applyPresence({
      workspaceId: "ws_1",
      botId: "bot_1",
      runtimeKind: "openclaw",
      instanceId: "inst_1",
      status: "available",
      acceptingInvocations: true,
      manifest,
    })

    expect(service.upsertPresenceFromBotKey).toHaveBeenCalledWith(expect.objectContaining({ manifest }))
  })

  it("fails closed when sealed delivery is denied", async () => {
    spyOn(e2eStreams, "resolveSealingContext").mockResolvedValue({
      streamIsE2e: true,
      actorHasGrant: false,
      externalSealedDelivery: true,
    })
    spyOn(agentRuntime, "resolveDeliveryVerdict").mockReturnValue({ delivery: "denied", reason: "no-key-grant" })
    const { client, service, ops } = setup()

    const result = await ops.renewClaim({ ...params, knownSourceRevision: 2 })

    expect(result).toEqual({
      invocationId: "binv_1",
      status: "cancelled",
      claimExpiresAt: null,
      sourceRevision: 2,
      reason: "key_grant_lost",
    })
    expect(service.cancelOwnedClaimForKeyGrantLossInTransaction).toHaveBeenCalledWith(client, expect.any(Object))
    expect(result).not.toHaveProperty("update")
  })

  it("returns durable key-grant cancellation without duplicating its transition", async () => {
    const cancelled = invocation({ status: "cancelled", cancellationReason: "key_grant_lost" })
    const { ops, service } = setup({ renewInvocationClaimInTransaction: mock(async () => cancelled) })

    const result = await ops.renewClaim({ ...params, knownSourceRevision: 2 })

    expect(result).toEqual({
      invocationId: "binv_1",
      status: "cancelled",
      claimExpiresAt: null,
      sourceRevision: 2,
      reason: "key_grant_lost",
    })
    expect(service.cancelOwnedClaimForKeyGrantLossInTransaction).not.toHaveBeenCalled()
  })

  it("assembles a sealed delta sequentially from one repeatable-read client", async () => {
    spyOn(e2eStreams, "resolveSealingContext").mockResolvedValue({
      streamIsE2e: true,
      actorHasGrant: true,
      externalSealedDelivery: true,
    })
    spyOn(agentRuntime, "resolveDeliveryVerdict").mockReturnValue({ delivery: "sealed" })
    const { client, ops } = setup()
    let active = false
    const calls: string[] = []
    const guarded = async <T>(name: string, value: T): Promise<T> => {
      if (active) throw new Error("overlapping PoolClient query")
      active = true
      calls.push(name)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active = false
      return value
    }
    spyOn(BotRuntimeInstanceRepository, "findByInstance").mockImplementation((db) => {
      expect(db).toBe(client)
      return guarded("instance", { publicKeyId: "bik_1" } as never)
    })
    spyOn(E2eStreamsRepository, "getByStreamId").mockImplementation((db) => {
      expect(db).toBe(client)
      return guarded("e2e", { currentKeyGeneration: 2 } as never)
    })
    spyOn(StreamE2eKeyWrapsRepository, "listForStream").mockImplementation((db) => {
      expect(db).toBe(client)
      return guarded("wraps", [
        { recipientKind: "bot", recipientKeyId: "bik_1", keyGeneration: 2, wrapEnc: "enc", wrapCt: "ct" },
      ] as never)
    })
    spyOn(MessageRepository, "findInvocationSourceStateForShare").mockImplementation((db) => {
      expect(db).toBe(client)
      return guarded("trigger", {
        workspaceId: "ws_1",
        streamId: "stream_active",
        revision: 2,
        deleted: false,
        ciphertext: Buffer.from("secret"),
        envelope: { v: 2, keyGeneration: 2, iv: "aXY=", aad: "YWFk" },
      } as never)
    })

    const result = await ops.renewClaim(params)

    expect(calls).toEqual(["instance", "e2e", "wraps", "trigger"])
    expect(result).toMatchObject({
      status: "active",
      sourceRevision: 2,
      update: { delivery: "sealed", sourceRevision: 2 },
    })
    expect(result).not.toHaveProperty("update.promptMarkdown")
    expect(AgentSessionRepository.updateInvocationReplyKeyGeneration).toHaveBeenCalledWith(client, {
      workspaceId: "ws_1",
      invocationId: "binv_1",
      replyKeyGeneration: 2,
    })
  })

  it("returns a retry conflict instead of labelling a newer trigger as the locked revision", async () => {
    spyOn(e2eStreams, "resolveSealingContext").mockResolvedValue({
      streamIsE2e: true,
      actorHasGrant: true,
      externalSealedDelivery: true,
    })
    spyOn(agentRuntime, "resolveDeliveryVerdict").mockReturnValue({ delivery: "sealed" })
    spyOn(BotRuntimeInstanceRepository, "findByInstance").mockResolvedValue({ publicKeyId: "bik_1" } as never)
    spyOn(E2eStreamsRepository, "getByStreamId").mockResolvedValue({ currentKeyGeneration: 2 } as never)
    spyOn(StreamE2eKeyWrapsRepository, "listForStream").mockResolvedValue([])
    spyOn(MessageRepository, "findInvocationSourceStateForShare").mockResolvedValue({
      workspaceId: "ws_1",
      streamId: "stream_active",
      revision: 3,
      deleted: false,
      ciphertext: Buffer.from("newer"),
      envelope: { v: 2, keyGeneration: 2, iv: "aXY=", aad: "YWFk" },
    } as never)
    const { ops, service } = setup()

    await expect(ops.renewClaim(params)).rejects.toMatchObject({ status: 409, code: "INVOCATION_CONTROL_RETRY" })
    expect(service.cancelOwnedClaimForKeyGrantLossInTransaction).not.toHaveBeenCalled()
  })
})
