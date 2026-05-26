import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { BotRuntimeService } from "./service"
import {
  BotInvocationRepository,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
  type BotInvocation,
  type BotRuntimeSessionLink,
  type StreamActiveActor,
} from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import * as db from "../../db"

const fakeQuerier = { query: mock(async () => ({ rows: [], rowCount: 0 })) }
const fakePool = fakeQuerier as never

function makeInvocation(overrides: Partial<BotInvocation> = {}): BotInvocation {
  const now = new Date("2026-05-26T12:00:00Z")
  return {
    id: "inv_1",
    workspaceId: "ws_1",
    rootStreamId: "stream_root",
    activeStreamId: "stream_active",
    sourceMessageId: "msg_src",
    responseStreamId: "stream_resp",
    actorType: "bot",
    actorId: "bot_alice",
    trigger: "active-scratchpad",
    requiredCapability: "active-scratchpad",
    promptMarkdown: "do a thing",
    authorUserId: "usr_owner",
    mentionedActorSlugs: [],
    targetInstanceId: null,
    targetRuntimeSessionId: null,
    metadata: {},
    status: "pending",
    claimedByInstanceId: null,
    claimToken: null,
    claimExpiresAt: null,
    attempts: 0,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  }
}

describe("BotRuntimeService outbox emission", () => {
  afterEach(() => {
    mock.restore()
  })

  // Stub `withTransaction` so the service runs its callback against our fake
  // querier without needing a real Postgres pool. The repo methods get spied
  // independently below to capture the calls.
  function patchWithTransaction() {
    return spyOn(db, "withTransaction").mockImplementation(async (_pool, fn) => fn(fakeQuerier as never))
  }

  function patchWithClient() {
    return spyOn(db, "withClient").mockImplementation(async (_pool, fn) => fn(fakeQuerier as never))
  }

  describe("createInvocation", () => {
    it("emits bot_invocation:available when the row is freshly inserted", async () => {
      patchWithTransaction()
      const inv = makeInvocation({ requiredCapability: "mentionable" })
      spyOn(BotInvocationRepository, "insertIdempotent").mockResolvedValue({
        invocation: inv,
        wasNewlyInserted: true,
      })
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      await service.createInvocation({
        workspaceId: inv.workspaceId,
        rootStreamId: inv.rootStreamId,
        activeStreamId: inv.activeStreamId,
        sourceMessageId: inv.sourceMessageId,
        responseStreamId: inv.responseStreamId,
        actorId: inv.actorId,
        trigger: "mention",
        requiredCapability: "mentionable",
        promptMarkdown: inv.promptMarkdown,
        authorUserId: inv.authorUserId,
      })

      expect(insertSpy).toHaveBeenCalledTimes(1)
      expect(insertSpy.mock.calls[0]?.[1]).toBe("bot_invocation:available")
      const payload = insertSpy.mock.calls[0]?.[2] as unknown as Record<string, unknown>
      expect(payload).toMatchObject({
        workspaceId: "ws_1",
        botId: "bot_alice",
        invocationId: "inv_1",
        requiredCapability: "mentionable",
        targetInstanceId: null,
        targetRuntimeSessionId: null,
      })
    })

    it("does not emit when the row was an idempotent retry (ON CONFLICT)", async () => {
      patchWithTransaction()
      spyOn(BotInvocationRepository, "insertIdempotent").mockResolvedValue({
        invocation: makeInvocation(),
        wasNewlyInserted: false,
      })
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      await service.createInvocation({
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
        activeStreamId: "stream_active",
        sourceMessageId: "msg_src",
        responseStreamId: "stream_resp",
        actorId: "bot_alice",
        trigger: "mention",
        requiredCapability: "mentionable",
        promptMarkdown: "x",
        authorUserId: "usr_owner",
      })

      expect(insertSpy).not.toHaveBeenCalled()
    })
  })

  describe("claimNextInvocation", () => {
    it("emits bot_invocation:claimed when a row is locked", async () => {
      patchWithTransaction()
      spyOn(BotInvocationRepository, "claimOne").mockResolvedValue(makeInvocation({ status: "claimed" }))
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      await service.claimNextInvocation({
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: "inst_42",
        runtimeKind: "pi-local",
        claimToken: "tok_1",
        supportedCapabilities: ["active-scratchpad"],
        claimTtlSeconds: 60,
      })

      expect(insertSpy).toHaveBeenCalledTimes(1)
      expect(insertSpy.mock.calls[0]?.[1]).toBe("bot_invocation:claimed")
      const payload = insertSpy.mock.calls[0]?.[2] as unknown as Record<string, unknown>
      expect(payload).toEqual({
        workspaceId: "ws_1",
        botId: "bot_alice",
        invocationId: "inv_1",
      })
    })

    it("does not emit when no row was available to claim", async () => {
      patchWithTransaction()
      spyOn(BotInvocationRepository, "claimOne").mockResolvedValue(null)
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      const result = await service.claimNextInvocation({
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: "inst_42",
        runtimeKind: "pi-local",
        claimToken: "tok_1",
        supportedCapabilities: ["active-scratchpad"],
        claimTtlSeconds: 60,
      })
      expect(result).toBeNull()
      expect(insertSpy).not.toHaveBeenCalled()
    })
  })

  describe("setActiveActorInTransaction", () => {
    function makeActor(overrides: Partial<StreamActiveActor> = {}): StreamActiveActor {
      return {
        id: "saa_1",
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
        actorType: "bot",
        actorId: "bot_new",
        createdBy: "usr_owner",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      }
    }

    it("emits bot:active_actor_changed with both displaced + new bot ids", async () => {
      spyOn(StreamActiveActorRepository, "findByRootStreamForUpdate").mockResolvedValue(
        makeActor({ actorType: "bot", actorId: "bot_old" })
      )
      spyOn(StreamActiveActorRepository, "upsert").mockResolvedValue(
        makeActor({ actorType: "bot", actorId: "bot_new" })
      )
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      await service.setActiveActorInTransaction(fakeQuerier as never, {
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
        actorType: "bot",
        actorId: "bot_new",
        createdBy: "usr_owner",
      })

      expect(insertSpy).toHaveBeenCalledTimes(1)
      expect(insertSpy.mock.calls[0]?.[1]).toBe("bot:active_actor_changed")
      const payload = insertSpy.mock.calls[0]?.[2] as unknown as Record<string, unknown>
      expect(payload).toMatchObject({
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
        previousActorType: "bot",
        previousActorId: "bot_old",
        newActorType: "bot",
        newActorId: "bot_new",
      })
      expect((payload.affectedBotIds as string[]).sort()).toEqual(["bot_new", "bot_old"])
    })

    it("does not emit when identity is unchanged", async () => {
      spyOn(StreamActiveActorRepository, "findByRootStreamForUpdate").mockResolvedValue(
        makeActor({ actorType: "bot", actorId: "bot_alice" })
      )
      spyOn(StreamActiveActorRepository, "upsert").mockResolvedValue(
        makeActor({ actorType: "bot", actorId: "bot_alice" })
      )
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      await service.setActiveActorInTransaction(fakeQuerier as never, {
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
        actorType: "bot",
        actorId: "bot_alice",
        createdBy: "usr_owner",
      })

      expect(insertSpy).not.toHaveBeenCalled()
    })

    it("populates affectedBotIds with only the new actor when displacing a persona", async () => {
      spyOn(StreamActiveActorRepository, "findByRootStreamForUpdate").mockResolvedValue(
        makeActor({ actorType: "persona", actorId: "persona_x" })
      )
      spyOn(StreamActiveActorRepository, "upsert").mockResolvedValue(
        makeActor({ actorType: "bot", actorId: "bot_new" })
      )
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      await service.setActiveActorInTransaction(fakeQuerier as never, {
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
        actorType: "bot",
        actorId: "bot_new",
        createdBy: "usr_owner",
      })

      const payload = insertSpy.mock.calls[0]?.[2] as unknown as Record<string, unknown>
      expect(payload.affectedBotIds).toEqual(["bot_new"])
    })
  })

  describe("getBootstrapForRuntime", () => {
    it("returns activeActorByStream and activeSessionLinks alongside invocations", async () => {
      patchWithClient()
      const actor: StreamActiveActor = {
        id: "saa_1",
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
        actorType: "bot",
        actorId: "bot_alice",
        createdBy: "usr_owner",
        createdAt: new Date("2026-05-26T11:00:00Z"),
        updatedAt: new Date("2026-05-26T11:30:00Z"),
      }
      const link: BotRuntimeSessionLink = {
        id: "brsl_1",
        workspaceId: "ws_1",
        botId: "bot_alice",
        runtimeKind: "pi-local",
        instanceId: "inst_42",
        runtimeSessionId: "sess_1",
        rootStreamId: "stream_root",
        activeStreamId: "stream_active",
        status: "active",
        linkedBy: "usr_owner",
        metadata: {},
        lastSeenAt: new Date("2026-05-26T11:45:00Z"),
        createdAt: new Date("2026-05-26T11:00:00Z"),
        updatedAt: new Date("2026-05-26T11:45:00Z"),
      }
      spyOn(BotInvocationRepository, "findBootstrapInvocations").mockResolvedValue({
        available: [makeInvocation()],
        ownedClaims: [],
      })
      spyOn(StreamActiveActorRepository, "findActiveForBot").mockResolvedValue([actor])
      spyOn(BotRuntimeSessionLinkRepository, "findActiveByBotInstance").mockResolvedValue([link])

      const service = new BotRuntimeService({ pool: fakePool })
      const result = await service.getBootstrapForRuntime({
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: "inst_42",
        supportedCapabilities: ["active-scratchpad"],
      })

      expect(result.available).toHaveLength(1)
      expect(result.activeActorByStream).toEqual([actor])
      expect(result.activeSessionLinks).toEqual([link])
    })

    it("opens a REPEATABLE READ READ ONLY transaction so all reads share a snapshot", async () => {
      patchWithClient()
      const querySpy = spyOn(fakeQuerier, "query") as unknown as { mock: { calls: unknown[][] } }
      spyOn(BotInvocationRepository, "findBootstrapInvocations").mockResolvedValue({ available: [], ownedClaims: [] })
      spyOn(StreamActiveActorRepository, "findActiveForBot").mockResolvedValue([])
      spyOn(BotRuntimeSessionLinkRepository, "findActiveByBotInstance").mockResolvedValue([])

      const service = new BotRuntimeService({ pool: fakePool })
      await service.getBootstrapForRuntime({
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: "inst_42",
        supportedCapabilities: ["active-scratchpad"],
      })

      const queries = querySpy.mock.calls.map((c) => c[0] as string)
      expect(queries).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
      expect(queries).toContain("COMMIT")
    })

    it("clamps a future sinceCursor to the 24h lookback floor", async () => {
      patchWithClient()
      const findSpy = spyOn(BotInvocationRepository, "findBootstrapInvocations").mockResolvedValue({
        available: [],
        ownedClaims: [],
      })
      spyOn(StreamActiveActorRepository, "findActiveForBot").mockResolvedValue([])
      spyOn(BotRuntimeSessionLinkRepository, "findActiveByBotInstance").mockResolvedValue([])

      const service = new BotRuntimeService({ pool: fakePool })
      const futureCursor = new Date(Date.now() + 60 * 60 * 1000) // +1h
      await service.getBootstrapForRuntime({
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: "inst_42",
        supportedCapabilities: ["active-scratchpad"],
        sinceCursor: futureCursor,
      })

      const sincePassed = (findSpy.mock.calls[0]?.[1] as { since: Date }).since
      expect(sincePassed.getTime()).toBeLessThan(futureCursor.getTime())
      // Should be within the 24h lookback window, not in the future.
      expect(sincePassed.getTime()).toBeLessThanOrEqual(Date.now())
      expect(sincePassed.getTime()).toBeGreaterThanOrEqual(Date.now() - 25 * 60 * 60 * 1000)
    })

    it("honors a recent sinceCursor inside the 24h window", async () => {
      patchWithClient()
      const findSpy = spyOn(BotInvocationRepository, "findBootstrapInvocations").mockResolvedValue({
        available: [],
        ownedClaims: [],
      })
      spyOn(StreamActiveActorRepository, "findActiveForBot").mockResolvedValue([])
      spyOn(BotRuntimeSessionLinkRepository, "findActiveByBotInstance").mockResolvedValue([])

      const service = new BotRuntimeService({ pool: fakePool })
      const recentCursor = new Date(Date.now() - 60 * 60 * 1000) // -1h
      await service.getBootstrapForRuntime({
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: "inst_42",
        supportedCapabilities: ["active-scratchpad"],
        sinceCursor: recentCursor,
      })

      expect((findSpy.mock.calls[0]?.[1] as { since: Date }).since).toEqual(recentCursor)
    })
  })

  describe("requestResyncInTransaction", () => {
    it("rejects instanceId without botId", async () => {
      const service = new BotRuntimeService({ pool: fakePool })
      await expect(
        service.requestResyncInTransaction(fakeQuerier as never, {
          workspaceId: "ws_1",
          botId: null,
          instanceId: "inst_42",
          reason: "test",
        })
      ).rejects.toThrow(/instanceId requires botId/)
    })

    it("emits bot:resync with normalized null targets", async () => {
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
      const service = new BotRuntimeService({ pool: fakePool })

      await service.requestResyncInTransaction(fakeQuerier as never, {
        workspaceId: "ws_1",
        reason: "admin_kicked",
      })

      expect(insertSpy.mock.calls[0]?.[1]).toBe("bot:resync")
      const payload = insertSpy.mock.calls[0]?.[2] as unknown as Record<string, unknown>
      expect(payload).toEqual({ workspaceId: "ws_1", botId: null, instanceId: null, reason: "admin_kicked" })
    })
  })
})
