import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { BotRuntimeService } from "./service"
import {
  BOT_CLAIM_MAX_ATTEMPTS,
  BotInvocationRepository,
  BotRuntimeInstanceRepository,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
  type BotInvocation,
  type BotRuntimeSessionLink,
  type StreamActiveActor,
} from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { MessageRepository, type InvocationSourceState } from "../messaging"
import { AgentSessionRepository, SessionStatuses } from "../agents"
import { StreamEventRepository } from "../streams"
import * as routeResolver from "./invocation-route-resolver"
import type { CanonicalInvocationRoute } from "./invocation-route-resolver"
import * as db from "../../db"
import * as streamsModule from "../streams"

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
    sourceMessageRevision: 1,
    claimedSourceMessageRevision: null,
    claimedInputUpdateMode: null,
    cancellationReason: null,
    authorUserId: "usr_owner",
    mentionedActorSlugs: [],
    targetInstanceId: null,
    targetRuntimeSessionId: null,
    metadata: {},
    status: "pending",
    claimedByInstanceId: null,
    claimedRuntimeSessionId: null,
    claimedRuntimeSessionClaimToken: null,
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

function sourceState(overrides: Partial<InvocationSourceState> = {}): InvocationSourceState {
  return {
    messageId: "msg_src",
    workspaceId: "ws_1",
    streamId: "stream_active",
    revision: 1,
    deleted: false,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "do a thing",
    ciphertext: null,
    envelope: null,
    authorId: "usr_owner",
    authorType: "user",
    ...overrides,
  }
}

function makeRoute(overrides: Partial<CanonicalInvocationRoute> = {}): CanonicalInvocationRoute {
  return {
    actorId: "bot_alice",
    trigger: "active-scratchpad",
    requiredCapability: "active-scratchpad",
    rootStreamId: "stream_root",
    activeStreamId: "stream_active",
    responseStreamId: "stream_resp",
    authorUserId: "usr_owner",
    mentionedActorSlugs: [],
    targetInstanceId: null,
    targetRuntimeSessionId: null,
    promptMarkdown: "do a thing",
    missingLinkNotice: null,
    ...overrides,
  }
}

function claimParams() {
  return {
    workspaceId: "ws_1",
    botId: "bot_alice",
    instanceId: "inst_42",
    runtimeKind: "pi-local" as const,
    claimToken: "tok_1",
    supportedCapabilities: ["active-scratchpad" as const],
    claimTtlSeconds: 60,
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
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({} as never)
    return spyOn(db, "withTransaction").mockImplementation(async (_pool, fn) => fn(fakeQuerier as never))
  }

  function patchWithClient() {
    return spyOn(db, "withClient").mockImplementation(async (_pool, fn) => fn(fakeQuerier as never))
  }

  describe("createInvocation", () => {
    it("emits bot_invocation:available when the row is freshly inserted", async () => {
      patchWithTransaction()
      spyOn(MessageRepository, "findInvocationSourceStateForShare").mockResolvedValue(sourceState())
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
      spyOn(MessageRepository, "findInvocationSourceStateForShare").mockResolvedValue(
        sourceState({ contentMarkdown: "x" })
      )
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
      spyOn(BotInvocationRepository, "parkExhausted").mockResolvedValue([])
      spyOn(BotInvocationRepository, "findNextClaimable").mockResolvedValue(makeInvocation())
      const claimSpy = spyOn(BotInvocationRepository, "claimOne").mockResolvedValue(
        makeInvocation({ status: "claimed" })
      )
      spyOn(MessageRepository, "findInvocationSourceStateForShare").mockResolvedValue(sourceState())
      spyOn(routeResolver, "resolveCanonicalInvocationRoutes").mockResolvedValue([makeRoute()])
      spyOn(BotInvocationRepository, "pinClaimSource").mockResolvedValue(makeInvocation({ status: "claimed" }))
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      await service.claimNextInvocation(claimParams())

      expect(claimSpy.mock.calls[0]?.[1]).toMatchObject({ maxAttempts: BOT_CLAIM_MAX_ATTEMPTS })
      expect(insertSpy).toHaveBeenCalledTimes(1)
      expect(insertSpy.mock.calls[0]?.[1]).toBe("bot_invocation:claimed")
      const payload = insertSpy.mock.calls[0]?.[2] as unknown as Record<string, unknown>
      expect(payload).toEqual({
        workspaceId: "ws_1",
        botId: "bot_alice",
        invocationId: "inv_1",
      })
    })

    it("parks invocations that exhausted their claim budget before handing out fresh work", async () => {
      patchWithTransaction()
      const exhausted = makeInvocation({ id: "inv_dead", status: "parked", attempts: BOT_CLAIM_MAX_ATTEMPTS })
      const parkSpy = spyOn(BotInvocationRepository, "parkExhausted").mockResolvedValue([exhausted])
      spyOn(BotInvocationRepository, "findNextClaimable").mockResolvedValue(null)
      spyOn(BotInvocationRepository, "claimOne").mockResolvedValue(null)
      spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
      const warnSpy = spyOn(logger, "warn").mockReturnValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      const result = await service.claimNextInvocation(claimParams())

      expect(result).toBeNull()
      expect(parkSpy).toHaveBeenCalledTimes(1)
      expect(parkSpy.mock.calls[0]?.[1]).toMatchObject({
        workspaceId: "ws_1",
        botId: "bot_alice",
        maxAttempts: BOT_CLAIM_MAX_ATTEMPTS,
      })
      // Each parked invocation is logged for operational visibility. Assert on
      // the logged content, not the call count — parkExhausted can return any
      // number of rows (INV-23).
      const warnedInvocationIds = warnSpy.mock.calls.map((call) => (call[0] as { invocationId?: string }).invocationId)
      expect(warnedInvocationIds).toContain("inv_dead")
    })

    it("terminal-fails a claimed invocation whose response target is no longer writable", async () => {
      patchWithTransaction()
      spyOn(streamsModule, "assertStreamWritable").mockRejectedValue(
        Object.assign(new Error("read only"), { code: "STREAM_READ_ONLY", details: { reason: "archived" } })
      )
      spyOn(BotInvocationRepository, "parkExhausted").mockResolvedValue([])
      spyOn(BotInvocationRepository, "findNextClaimable").mockResolvedValue(makeInvocation())
      spyOn(BotInvocationRepository, "claimOne").mockResolvedValue(makeInvocation({ status: "claimed" }))
      spyOn(MessageRepository, "findInvocationSourceStateForShare").mockResolvedValue({
        messageId: "msg_src",
        workspaceId: "ws_1",
        streamId: "stream_active",
        revision: 1,
        deleted: false,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "do a thing",
        ciphertext: null,
        envelope: null,
        authorId: "usr_owner",
        authorType: "user",
      })
      const pin = spyOn(BotInvocationRepository, "pinClaimSource").mockResolvedValue(
        makeInvocation({ status: "claimed", claimedSourceMessageRevision: 1 })
      )
      const failClaim = spyOn(BotInvocationRepository, "failClaim").mockResolvedValue(
        makeInvocation({ status: "failed" })
      )
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const result = await new BotRuntimeService({ pool: fakePool }).claimNextInvocation({
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: "inst_42",
        runtimeKind: "pi-local",
        claimToken: "tok_1",
        supportedCapabilities: ["active-scratchpad"],
        claimTtlSeconds: 60,
      })

      expect({ result, pinned: pin.mock.calls.length }).toEqual({ result: null, pinned: 1 })
      expect(failClaim).toHaveBeenCalledWith(
        fakeQuerier,
        expect.objectContaining({
          invocationId: "inv_1",
          errorMessage: "STREAM_READ_ONLY:archived",
        })
      )
      expect(insertSpy).not.toHaveBeenCalled()
    })

    it("does not emit when no row was available to claim", async () => {
      patchWithTransaction()
      spyOn(BotInvocationRepository, "parkExhausted").mockResolvedValue([])
      spyOn(BotInvocationRepository, "findNextClaimable").mockResolvedValue(null)
      spyOn(BotInvocationRepository, "claimOne").mockResolvedValue(null)
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      const result = await service.claimNextInvocation(claimParams())
      expect(result).toBeNull()
      expect(insertSpy).not.toHaveBeenCalled()
    })

    it("cancels one stale route and stops when no other candidate exists", async () => {
      patchWithTransaction()
      spyOn(BotInvocationRepository, "parkExhausted").mockResolvedValue([])
      spyOn(BotInvocationRepository, "findNextClaimable").mockResolvedValue(makeInvocation())
      const candidate = makeInvocation({ status: "claimed", claimedByInstanceId: "inst_42", claimToken: "tok_1" })
      const claim = spyOn(BotInvocationRepository, "claimOne")
        .mockResolvedValueOnce(candidate)
        .mockResolvedValueOnce(null)
      spyOn(MessageRepository, "findInvocationSourceStateForShare").mockResolvedValue(
        sourceState({ revision: 2, contentMarkdown: "route removed" })
      )
      spyOn(routeResolver, "resolveCanonicalInvocationRoutes").mockResolvedValue([])
      const cancel = spyOn(BotInvocationRepository, "cancelClaim").mockResolvedValue(
        makeInvocation({ status: "cancelled", cancellationReason: "routing_changed" })
      )
      spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)

      const result = await new BotRuntimeService({ pool: fakePool }).claimNextInvocation(claimParams())

      expect({ result, claimCalls: claim.mock.calls.length, cancelCalls: cancel.mock.calls.length }).toEqual({
        result: null,
        claimCalls: 2,
        cancelCalls: 1,
      })
    })

    it("rolls back and stops if stale-candidate cancellation loses its claim fence", async () => {
      patchWithTransaction()
      spyOn(BotInvocationRepository, "parkExhausted").mockResolvedValue([])
      spyOn(BotInvocationRepository, "findNextClaimable").mockResolvedValue(makeInvocation())
      const claim = spyOn(BotInvocationRepository, "claimOne").mockResolvedValue(
        makeInvocation({ status: "claimed", claimedByInstanceId: "inst_42", claimToken: "tok_1" })
      )
      spyOn(MessageRepository, "findInvocationSourceStateForShare").mockResolvedValue(null)
      spyOn(routeResolver, "resolveCanonicalInvocationRoutes").mockResolvedValue([])
      spyOn(BotInvocationRepository, "cancelClaim").mockResolvedValue(null)

      const result = await new BotRuntimeService({ pool: fakePool }).claimNextInvocation(claimParams())

      expect({ result, claimCalls: claim.mock.calls.length }).toEqual({ result: null, claimCalls: 1 })
    })

    it("terminalizes an expired re-claim session when canonical deletion invalidates it", async () => {
      patchWithTransaction()
      spyOn(BotInvocationRepository, "parkExhausted").mockResolvedValue([])
      spyOn(BotInvocationRepository, "findNextClaimable").mockResolvedValue(makeInvocation())
      spyOn(BotInvocationRepository, "claimOne")
        .mockResolvedValueOnce(
          makeInvocation({ status: "claimed", claimedByInstanceId: "inst_42", claimToken: "tok_1" })
        )
        .mockResolvedValueOnce(null)
      spyOn(MessageRepository, "findInvocationSourceStateForShare").mockResolvedValue(
        sourceState({ revision: 2, deleted: true, contentMarkdown: "deleted" })
      )
      spyOn(routeResolver, "resolveCanonicalInvocationRoutes").mockResolvedValue([])
      spyOn(BotInvocationRepository, "cancelClaim").mockResolvedValue(
        makeInvocation({ status: "cancelled", cancellationReason: "source_deleted" })
      )
      const updateStatus = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null)

      await new BotRuntimeService({ pool: fakePool }).claimNextInvocation(claimParams())

      expect(updateStatus).toHaveBeenCalledWith(
        fakeQuerier,
        "inv_1",
        SessionStatuses.DELETED,
        expect.objectContaining({ onlyIfStatusIn: [SessionStatuses.RUNNING, SessionStatuses.COMPLETED] })
      )
    })
  })

  describe("source reconciliation session lifecycle", () => {
    it("routing cancellation supersedes the session without inventing a wire event", async () => {
      patchWithTransaction()
      spyOn(MessageRepository, "findInvocationSourceStateForShare").mockResolvedValue(
        sourceState({ revision: 2, contentMarkdown: "route removed" })
      )
      spyOn(routeResolver, "resolveCanonicalInvocationRoutes").mockResolvedValue([])
      spyOn(BotInvocationRepository, "cancelActiveRoutesNotDesired").mockResolvedValue([
        makeInvocation({ status: "cancelled", cancellationReason: "routing_changed" }),
      ])
      const updateStatus = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue({
        id: "inv_1",
        status: SessionStatuses.SUPERSEDED,
      } as never)
      const insertEvent = spyOn(StreamEventRepository, "insert")
      const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      await new BotRuntimeService({ pool: fakePool }).reconcileInvocationSource({
        workspaceId: "ws_1",
        sourceMessageId: "msg_src",
      })

      expect(updateStatus).toHaveBeenCalledWith(
        fakeQuerier,
        "inv_1",
        SessionStatuses.SUPERSEDED,
        expect.objectContaining({ onlyIfStatusIn: [SessionStatuses.RUNNING] })
      )
      expect(insertEvent).not.toHaveBeenCalled()
      expect(insertOutbox).toHaveBeenCalledWith(
        fakeQuerier,
        "bot_invocation:cancelled",
        expect.objectContaining({ invocationId: "inv_1", sourceRevision: 1, reason: "routing_changed" })
      )
    })

    it("inserts reconciled actors in canonical actor-source lock order", async () => {
      patchWithTransaction()
      spyOn(MessageRepository, "findInvocationSourceStateForShare").mockResolvedValue(
        sourceState({ revision: 2, contentMarkdown: "route actors" })
      )
      spyOn(routeResolver, "resolveCanonicalInvocationRoutes").mockResolvedValue(
        ["bot_zulu", "bot_alpha"].map((actorId) => makeRoute({ actorId, promptMarkdown: "route actors" }))
      )
      spyOn(BotInvocationRepository, "cancelActiveRoutesNotDesired").mockResolvedValue([])
      const insertInvocation = spyOn(BotInvocationRepository, "insertIdempotent").mockImplementation(
        async (_db, params) => ({
          invocation: makeInvocation({ actorId: params.actorId }),
          wasNewlyInserted: false,
        })
      )

      await new BotRuntimeService({ pool: fakePool }).reconcileInvocationSource({
        workspaceId: "ws_1",
        sourceMessageId: "msg_src",
      })

      expect(insertInvocation.mock.calls.map((call) => call[1].actorId)).toEqual(["bot_alpha", "bot_zulu"])
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
      spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue(
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
      spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue(
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
      spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue(
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

    it("acquires a pg_advisory_xact_lock before reading the row so insert-vs-insert races serialize", async () => {
      // SELECT ... FOR UPDATE alone doesn't help when the row doesn't exist
      // yet: two concurrent inserts both see existing=null and the loser
      // emits `bot:active_actor_changed` with `previousActorId=null`. The
      // advisory lock keyed by (workspaceId, rootStreamId) closes that gap.
      const callOrder: string[] = []
      const querier = {
        query: mock(async (text: string) => {
          if (text.includes("pg_advisory_xact_lock")) callOrder.push("advisory_lock")
          return { rows: [], rowCount: 0 }
        }),
      }
      spyOn(StreamActiveActorRepository, "findByRootStream").mockImplementation(async () => {
        callOrder.push("find")
        return null
      })
      spyOn(StreamActiveActorRepository, "upsert").mockImplementation(async (_db, params) => {
        callOrder.push("upsert")
        return {
          ...params,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as StreamActiveActor
      })
      spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      await service.setActiveActorInTransaction(querier as never, {
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
        actorType: "bot",
        actorId: "bot_new",
        createdBy: "usr_owner",
      })

      expect(callOrder).toEqual(["advisory_lock", "find", "upsert"])
      const lockCall = (querier.query as ReturnType<typeof mock>).mock.calls.find((c) =>
        (c[0] as string).includes("pg_advisory_xact_lock")
      )
      expect(lockCall?.[1]).toEqual(["stream_active_actors:ws_1:stream_root"])
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
      const findSpy = spyOn(BotInvocationRepository, "findBootstrapInvocations").mockResolvedValue({
        available: [makeInvocation()],
        ownedClaims: [],
        recentCancellations: [],
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
      // Bootstrap must apply the same attempt ceiling as the claim path, or it
      // would re-advertise exhausted invocations even though claimOne refuses
      // them. Pin the plumbing here so a dropped arg fails at the service layer.
      expect(findSpy.mock.calls[0]?.[1]).toMatchObject({ maxAttempts: BOT_CLAIM_MAX_ATTEMPTS })
    })

    it("opens a REPEATABLE READ READ ONLY transaction so all reads share a snapshot", async () => {
      patchWithClient()
      const querySpy = spyOn(fakeQuerier, "query") as unknown as { mock: { calls: unknown[][] } }
      spyOn(BotInvocationRepository, "findBootstrapInvocations").mockResolvedValue({
        available: [],
        ownedClaims: [],
        recentCancellations: [],
      })
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
        recentCancellations: [],
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
        recentCancellations: [],
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

  describe("createLinkedScratchpadSession", () => {
    it("creates the scratchpad, bot grant, label, and session link in one transaction", async () => {
      patchWithTransaction()
      const streamService = {
        createScratchpadInTransaction: mock(() => Promise.resolve({ id: "stream_1" })),
        addBotToStreamOn: mock(() => Promise.resolve()),
      }
      const labelAssignmentService = {
        assignByNameInTransaction: mock(() => Promise.resolve({})),
      }
      spyOn(BotRuntimeService.prototype, "repairBotTraitsInTransaction").mockResolvedValue(undefined)
      const createLinkSpy = spyOn(
        BotRuntimeService.prototype,
        "createOrLinkPiRemoteSessionInTransaction"
      ).mockResolvedValue({
        id: "brsl_1",
        rootStreamId: "stream_1",
        activeStreamId: "stream_1",
        runtimeSessionId: "sess_1",
      } as never)
      const service = new BotRuntimeService({
        pool: fakePool,
        streamService: streamService as never,
        labelAssignmentService: labelAssignmentService as never,
      })

      const result = await service.createLinkedScratchpadSession({
        workspaceId: "ws_1",
        botId: "bot_1",
        ownerUserId: "usr_owner",
        runtimeKind: "pi-local",
        instanceId: "inst_1",
        runtimeSessionId: "sess_1",
        displayName: "Pi remote - threa",
        localCwd: "/repo/threa",
        labelName: "Pi remote",
        traits: ["active-scratchpad"],
      })

      expect(streamService.createScratchpadInTransaction).toHaveBeenCalledWith(
        fakeQuerier,
        expect.objectContaining({ workspaceId: "ws_1", displayName: "Pi remote - threa", createdBy: "usr_owner" })
      )
      expect(streamService.addBotToStreamOn).toHaveBeenCalledWith(fakeQuerier, "stream_1", "bot_1", "ws_1", "usr_owner")
      expect(labelAssignmentService.assignByNameInTransaction).toHaveBeenCalledWith(
        fakeQuerier,
        expect.objectContaining({ name: "Pi remote", resourceId: "stream_1" })
      )
      expect(createLinkSpy).toHaveBeenCalledWith(
        fakeQuerier,
        expect.objectContaining({
          rootStreamId: "stream_1",
          activeStreamId: "stream_1",
          linkedBy: "usr_owner",
          metadata: { displayName: "Pi remote - threa", localCwd: "/repo/threa" },
        })
      )
      expect(result.link.id).toBe("brsl_1")
      expect(result.stream.id).toBe("stream_1")
    })

    it("threads a description + bot attribution into the scratchpad create", async () => {
      patchWithTransaction()
      const streamService = {
        createScratchpadInTransaction: mock(() => Promise.resolve({ id: "stream_1" })),
        addBotToStreamOn: mock(() => Promise.resolve()),
      }
      const labelAssignmentService = { assignByNameInTransaction: mock(() => Promise.resolve({})) }
      spyOn(BotRuntimeService.prototype, "repairBotTraitsInTransaction").mockResolvedValue(undefined)
      spyOn(BotRuntimeService.prototype, "createOrLinkPiRemoteSessionInTransaction").mockResolvedValue({
        id: "brsl_1",
        rootStreamId: "stream_1",
        activeStreamId: "stream_1",
        runtimeSessionId: "sess_1",
      } as never)
      const service = new BotRuntimeService({
        pool: fakePool,
        streamService: streamService as never,
        labelAssignmentService: labelAssignmentService as never,
      })

      await service.createLinkedScratchpadSession({
        workspaceId: "ws_1",
        botId: "bot_1",
        ownerUserId: "usr_owner",
        runtimeKind: "pi-local",
        instanceId: "inst_1",
        runtimeSessionId: "sess_1",
        displayName: "Pi remote - threa",
        description: "Handover: continue the refactor in apps/backend",
        traits: ["active-scratchpad"],
      })

      expect(streamService.createScratchpadInTransaction).toHaveBeenCalledWith(
        fakeQuerier,
        expect.objectContaining({
          description: "Handover: continue the refactor in apps/backend",
          descriptionActor: { id: "bot_1", type: "bot" },
        })
      )
    })

    it("rejects and lets the transaction roll back when label assignment fails", async () => {
      patchWithTransaction()
      const streamService = {
        createScratchpadInTransaction: mock(() => Promise.resolve({ id: "stream_1" })),
        addBotToStreamOn: mock(() => Promise.resolve()),
      }
      const labelAssignmentService = {
        assignByNameInTransaction: mock(() => Promise.reject(new Error("boom"))),
      }
      const createLinkSpy = spyOn(BotRuntimeService.prototype, "createOrLinkPiRemoteSessionInTransaction")
      const service = new BotRuntimeService({
        pool: fakePool,
        streamService: streamService as never,
        labelAssignmentService: labelAssignmentService as never,
      })

      await expect(
        service.createLinkedScratchpadSession({
          workspaceId: "ws_1",
          botId: "bot_1",
          ownerUserId: "usr_owner",
          runtimeKind: "pi-local",
          instanceId: "inst_1",
          runtimeSessionId: "sess_1",
          displayName: "Pi remote - threa",
          labelName: "Pi remote",
          traits: ["active-scratchpad"],
        })
      ).rejects.toThrow("boom")

      expect(createLinkSpy).not.toHaveBeenCalled()
    })
  })
  describe("archive/unarchive session-link lifecycle", () => {
    function makeLink(overrides: Partial<BotRuntimeSessionLink> = {}): BotRuntimeSessionLink {
      const now = new Date("2026-07-10T12:00:00Z")
      return {
        id: "brsl_1",
        workspaceId: "ws_1",
        botId: "bot_alice",
        runtimeKind: "claude-code-channel",
        instanceId: "inst_42",
        runtimeSessionId: "sess_1",
        rootStreamId: "stream_root",
        activeStreamId: "stream_root",
        status: "active",
        linkedBy: "usr_owner",
        metadata: {},
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      }
    }

    it("endSessionsForArchivedStream marks links archived and emits bot:session_archived per link", async () => {
      patchWithTransaction()
      spyOn(BotRuntimeSessionLinkRepository, "archiveActiveByRootStream").mockResolvedValue([
        makeLink({ status: "archived" }),
      ])
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      const count = await service.endSessionsForArchivedStream({ workspaceId: "ws_1", rootStreamId: "stream_root" })

      expect(count).toBe(1)
      expect(insertSpy.mock.calls[0]?.[1]).toBe("bot:session_archived")
      expect(insertSpy.mock.calls[0]?.[2]).toEqual({
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: "inst_42",
        runtimeSessionId: "sess_1",
        rootStreamId: "stream_root",
      })
    })

    it("restoreSessionsForUnarchivedStream revives archive-ended links and emits bot:session_restored per link", async () => {
      patchWithTransaction()
      const reactivateSpy = spyOn(BotRuntimeSessionLinkRepository, "reactivateArchivedByRootStream").mockResolvedValue([
        makeLink({ status: "active" }),
      ])
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      const count = await service.restoreSessionsForUnarchivedStream({
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
      })

      expect(count).toBe(1)
      expect(reactivateSpy.mock.calls[0]?.[1]).toEqual({ workspaceId: "ws_1", rootStreamId: "stream_root" })
      expect(insertSpy.mock.calls[0]?.[1]).toBe("bot:session_restored")
      expect(insertSpy.mock.calls[0]?.[2]).toEqual({
        workspaceId: "ws_1",
        botId: "bot_alice",
        instanceId: "inst_42",
        runtimeSessionId: "sess_1",
        rootStreamId: "stream_root",
      })
    })

    it("restoreSessionsForUnarchivedStream emits nothing when no archived links exist (normal-shutdown links stay dead)", async () => {
      patchWithTransaction()
      spyOn(BotRuntimeSessionLinkRepository, "reactivateArchivedByRootStream").mockResolvedValue([])
      const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

      const service = new BotRuntimeService({ pool: fakePool })
      const count = await service.restoreSessionsForUnarchivedStream({
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
      })

      expect(count).toBe(0)
      expect(insertSpy).not.toHaveBeenCalled()
    })

    it("reattachArchivedRuntimeSession revives the link, refreshes presence, and re-claims the active-actor slot", async () => {
      patchWithTransaction()
      const revived = makeLink({ status: "active" })
      spyOn(BotRuntimeSessionLinkRepository, "reactivateArchivedByRuntimeSession").mockResolvedValue(revived)
      const presenceSpy = spyOn(BotRuntimeInstanceRepository, "upsertPresence").mockResolvedValue({} as never)
      const setActorSpy = spyOn(BotRuntimeService.prototype, "setActiveActorInTransaction").mockResolvedValue(
        {} as never
      )

      const service = new BotRuntimeService({ pool: fakePool })
      const result = await service.reattachArchivedRuntimeSession({
        workspaceId: "ws_1",
        botId: "bot_alice",
        runtimeKind: "claude-code-channel",
        instanceId: "inst_42",
        runtimeSessionId: "sess_1",
      })

      expect(result).toEqual({ status: "reattached", link: revived })
      expect(presenceSpy).toHaveBeenCalled()
      expect(setActorSpy.mock.calls[0]?.[1]).toMatchObject({
        workspaceId: "ws_1",
        rootStreamId: "stream_root",
        actorType: "bot",
        actorId: "bot_alice",
        createdBy: "usr_owner",
      })
    })

    it("reattachArchivedRuntimeSession reports a concurrently revived link as reattached, not archived_stream", async () => {
      patchWithTransaction()
      // SKIP LOCKED found no 'archived' row because a concurrent reattach (or
      // the unarchive consumer) already committed the revival.
      spyOn(BotRuntimeSessionLinkRepository, "reactivateArchivedByRuntimeSession").mockResolvedValue(null)
      const active = makeLink({ status: "active" })
      spyOn(BotRuntimeSessionLinkRepository, "findActiveByRuntimeSession").mockResolvedValue(active)
      const findArchived = spyOn(BotRuntimeSessionLinkRepository, "findArchivedByRuntimeSession")

      const service = new BotRuntimeService({ pool: fakePool })
      const result = await service.reattachArchivedRuntimeSession({
        workspaceId: "ws_1",
        botId: "bot_alice",
        runtimeKind: "claude-code-channel",
        instanceId: "inst_42",
        runtimeSessionId: "sess_1",
      })

      expect(result).toEqual({ status: "reattached", link: active })
      expect(findArchived).not.toHaveBeenCalled()
    })

    it("reattachArchivedRuntimeSession reports archived_stream when the link exists but its stream is still archived", async () => {
      patchWithTransaction()
      spyOn(BotRuntimeSessionLinkRepository, "reactivateArchivedByRuntimeSession").mockResolvedValue(null)
      spyOn(BotRuntimeSessionLinkRepository, "findActiveByRuntimeSession").mockResolvedValue(null)
      spyOn(BotRuntimeSessionLinkRepository, "findArchivedByRuntimeSession").mockResolvedValue(
        makeLink({ status: "archived" })
      )

      const service = new BotRuntimeService({ pool: fakePool })
      const result = await service.reattachArchivedRuntimeSession({
        workspaceId: "ws_1",
        botId: "bot_alice",
        runtimeKind: "claude-code-channel",
        instanceId: "inst_42",
        runtimeSessionId: "sess_1",
      })

      expect(result).toEqual({ status: "archived_stream" })
    })

    it("reattachArchivedRuntimeSession reports none when no archived link exists for the runtime session", async () => {
      patchWithTransaction()
      spyOn(BotRuntimeSessionLinkRepository, "reactivateArchivedByRuntimeSession").mockResolvedValue(null)
      spyOn(BotRuntimeSessionLinkRepository, "findActiveByRuntimeSession").mockResolvedValue(null)
      spyOn(BotRuntimeSessionLinkRepository, "findArchivedByRuntimeSession").mockResolvedValue(null)

      const service = new BotRuntimeService({ pool: fakePool })
      const result = await service.reattachArchivedRuntimeSession({
        workspaceId: "ws_1",
        botId: "bot_alice",
        runtimeKind: "claude-code-channel",
        instanceId: "inst_42",
        runtimeSessionId: "sess_1",
      })

      expect(result).toEqual({ status: "none" })
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
