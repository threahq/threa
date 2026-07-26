import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import * as db from "../../db"
import * as agents from "../agents"
import { AgentSessionRepository, ConversationSummaryRepository, hashCallbackToken } from "../agents"
import { StreamRepository, StreamEventRepository, StreamPoliciesRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { E2eStreamActorsRepository, E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../e2e-streams"
import type { E2eStream, E2eStreamActor, StreamE2eKeyWrap } from "../e2e-streams"
import { MessageRepository } from "../messaging"
import { AttachmentRepository } from "../attachments"
import type { StorageProvider } from "../../lib/storage/s3-client"
import type { Message } from "../messaging"
import { UserRepository } from "../workspaces"
import type { UserPreferencesService } from "../user-preferences"
import { EnclaveInvocationsRepository, type EnclaveInvocation } from "./invocations-repository"
import { EnclaveRewrapNotificationsRepository } from "./rewrap-notifications-repository"
import { EnclaveClaimService, enqueueEnclaveInvocation } from "./claim-service"
import { ENCLAVE_INVOCATION_CHANNEL } from "./claim-nudge"

const pool = {} as Pool

const INVOCATION: EnclaveInvocation = {
  id: "einv_1",
  workspaceId: "ws_1",
  streamId: "stream_1",
  rootStreamId: "stream_1",
  messageId: "msg_trigger",
  triggeredBy: "usr_kris",
  status: "claimed",
  claimedByKeyId: "eik_live",
  claimToken: "cbtok_minted",
  claimExpiresAt: new Date(Date.now() + 60_000),
  sessionId: null,
  attempts: 1,
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
}

const E2E: E2eStream = {
  streamId: "stream_1",
  workspaceId: "ws_1",
  enabledAt: new Date(),
  ownerUserId: "usr_owner",
  ownerUserKeyId: "e2ek_owner",
  currentKeyGeneration: 1,
  hasSealedName: false,
}
const ENCLAVE_ACTOR: E2eStreamActor = { kind: "enclave", actorId: "enclave", keyId: null }
const WRAP: StreamE2eKeyWrap = {
  keyGeneration: 1,
  recipientKeyId: "eik_live",
  recipientKind: "enclave",
  wrapEnc: "enc_1",
  wrapCt: "ct_1",
}
const TRIGGER = {
  id: "msg_trigger",
  authorType: "user",
  authorId: "usr_kris",
  createdAt: new Date("2026-06-02T09:27:00.000Z"),
  ciphertext: Buffer.from("cipher:hello"),
  envelope: { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" },
} as unknown as Message

afterEach(() => mock.restore())

const FAKE_STORAGE = { getObject: async () => Buffer.from("") } as unknown as StorageProvider
const FAKE_PREFERENCES = { getPreferences: async () => ({}) } as unknown as UserPreferencesService

/** Stub everything up to the session insert; returns the sentinel tx withTransaction runs on plus the claim-lifecycle spies. */
function arrangeClaim(invocation: EnclaveInvocation = INVOCATION) {
  const claimNext = spyOn(EnclaveInvocationsRepository, "claimNext")
    .mockResolvedValueOnce(invocation)
    .mockResolvedValue(null)
  const completeClaimed = spyOn(EnclaveInvocationsRepository, "completeClaimed").mockResolvedValue(undefined)
  const attachSession = spyOn(EnclaveInvocationsRepository, "attachSession").mockResolvedValue(undefined)
  spyOn(EnclaveInvocationsRepository, "parkExhausted").mockResolvedValue([])
  spyOn(E2eStreamsRepository, "getByStreamId").mockResolvedValue(E2E)
  spyOn(E2eStreamActorsRepository, "listForStream").mockResolvedValue([ENCLAVE_ACTOR])
  spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
  spyOn(MessageRepository, "findById").mockResolvedValue(TRIGGER)
  spyOn(StreamE2eKeyWrapsRepository, "listForStream").mockResolvedValue([WRAP])
  spyOn(MessageRepository, "findSurrounding").mockResolvedValue([])
  spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
  spyOn(AgentSessionRepository, "findRecentDigestStepsByStream").mockResolvedValue([])
  spyOn(ConversationSummaryRepository, "findByStreamAndPersona").mockResolvedValue(null)
  spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" } as never)
  spyOn(StreamPoliciesRepository, "getToolPolicy").mockResolvedValue(null)
  spyOn(UserRepository, "findByIds").mockResolvedValue([{ name: "Kris" }] as never)
  spyOn(agents, "buildEnclaveSystemPrompt").mockResolvedValue({ stable: "You are Ariadne.", volatile: "" })

  const tx = { __tx: true } as never
  spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
    fn(tx)) as never)
  return { tx, claimNext, completeClaimed, attachSession }
}

function service() {
  return new EnclaveClaimService({ pool, storage: FAKE_STORAGE, userPreferencesService: FAKE_PREFERENCES })
}

describe("EnclaveClaimService.claimTurn", () => {
  it("commits the session row, the started lifecycle event, and the claim's session stamp in one transaction (INV-7)", async () => {
    const { tx, attachSession: attach } = arrangeClaim()
    const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date("2026-06-02T09:27:01.000Z"),
    } as never)
    const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const assignment = await service().claimTurn("eik_live")

    expect(assignment).not.toBeNull()
    // All three writes ran on the same transaction client — a crash between
    // them can't leave a RUNNING session with no started event (invisible to
    // the stream view yet blocking the one-running guard) or an unaddressable
    // claim the session callbacks can't flip.
    expect(insertSession.mock.calls[0]![0]).toBe(tx)
    expect(insertEvent.mock.calls[0]![0]).toBe(tx)
    expect(attach.mock.calls[0]![0]).toBe(tx)
    expect(attach.mock.calls[0]![1]).toMatchObject({ id: "einv_1" })
    expect(insertEvent.mock.calls[0]![1]).toMatchObject({
      streamId: "stream_1",
      eventType: "agent_session:started",
      payload: { personaId: agents.ARIADNE_AGENT_ID, triggerMessageId: "msg_trigger" },
    })
    expect(insertOutbox.mock.calls[0]![0]).toBe(tx)
    expect(insertOutbox.mock.calls[0]![1]).toBe("agent_session:started")
  })

  it("binds callbacks to the claiming runner: the claim token rides the assignment, its hash the row, plus the seal generation (Phase 2.4b)", async () => {
    arrangeClaim()
    const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date("2026-06-02T09:27:01.000Z"),
    } as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const assignment = await service().claimTurn("eik_live")

    const inserted = insertSession.mock.calls[0]![1] as {
      serverId: string
      callbackTokenHash: string
      replyKeyGeneration: number
    }
    // The cleartext secret travels to exactly one place — inside the claim
    // response to the winning instance — so echoing it proves the caller is
    // that runner. The row stores only the digest: a DB read can't
    // impersonate the runner.
    expect(typeof assignment!.callbackToken).toBe("string")
    expect(assignment!.callbackToken!.length).toBeGreaterThan(0)
    expect(inserted.callbackTokenHash).toBe(hashCallbackToken(assignment!.callbackToken!))
    expect(inserted.serverId).toBe("eik_live")
    // The row records the generation the assignment prescribes, so a callback
    // sealed under any other generation is rejected instead of persisted.
    expect(inserted.replyKeyGeneration).toBe(assignment!.reply.keyGeneration)
  })

  it("resolves the SSK + wraps from the invocation's root for a thread trigger (reply still lands in the thread)", async () => {
    arrangeClaim({ ...INVOCATION, rootStreamId: "stream_root" })
    // The trigger lives in a THREAD whose root is stream_root; the thread shares
    // the root's SSK and carries no wraps of its own.
    spyOn(StreamRepository, "findById").mockImplementation((async (_p: unknown, id: string) =>
      id === "stream_1"
        ? { id: "stream_1", workspaceId: "ws_1", rootStreamId: "stream_root" }
        : { id: "stream_root", workspaceId: "ws_1", rootStreamId: null }) as never)
    const getE2e = spyOn(E2eStreamsRepository, "getByStreamId").mockResolvedValue({ ...E2E, streamId: "stream_root" })
    const listWraps = spyOn(StreamE2eKeyWrapsRepository, "listForStream").mockResolvedValue([WRAP])
    const getPolicy = spyOn(StreamPoliciesRepository, "getToolPolicy").mockResolvedValue(null)
    const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date(),
    } as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const assignment = await service().claimTurn("eik_live")

    // Key material (e2e row + wraps) and the tool policy are fetched against the root...
    expect(getE2e).toHaveBeenCalledWith(pool, "ws_1", "stream_root")
    expect(listWraps).toHaveBeenCalledWith(pool, "ws_1", "stream_root")
    expect(getPolicy).toHaveBeenCalledWith(pool, "ws_1", "stream_root")
    // ...the assignment carries the root id, so the enclave unwraps under the
    // AAD the wraps were sealed with...
    expect(assignment!.streamId).toBe("stream_root")
    // ...but the session (and therefore Ariadne's reply) lands in the thread.
    expect(insertSession.mock.calls[0]![1]).toMatchObject({ streamId: "stream_1" })
  })

  it("threads the stream's tool-privacy policy from stream_policies onto the assignment", async () => {
    arrangeClaim()
    spyOn(StreamPoliciesRepository, "getToolPolicy").mockResolvedValue(["web"])
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date(),
    } as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const assignment = await service().claimTurn("eik_live")
    expect(assignment!.allowedToolCategories).toEqual(["web"])
  })

  it("ships attachment ciphertext for the trigger AND recent history, trigger first", async () => {
    arrangeClaim()
    // One prior message in the window carrying its own E2E attachment.
    spyOn(MessageRepository, "findSurrounding").mockResolvedValue([
      {
        id: "msg_history",
        authorType: "user",
        sequence: 1n,
        ciphertext: Buffer.from("cipher:earlier"),
        envelope: { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" },
      },
      TRIGGER,
    ] as never)
    spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(
      new Map([
        ["msg_trigger", [{ id: "attach_t", e2eOnly: true, sizeBytes: 10, storagePath: "p/t" }]],
        ["msg_history", [{ id: "attach_h", e2eOnly: true, sizeBytes: 10, storagePath: "p/h" }]],
      ]) as never
    )
    const getObject = mock(async (path: string) => Buffer.from(`bytes:${path}`))
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date(),
    } as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const svc = new EnclaveClaimService({
      pool,
      storage: { getObject } as unknown as StorageProvider,
      userPreferencesService: FAKE_PREFERENCES,
    })
    const assignment = await svc.claimTurn("eik_live")

    expect(assignment!.attachmentCiphertexts).toEqual([
      { attachmentId: "attach_t", ciphertext: Buffer.from("bytes:p/t").toString("base64") },
      { attachmentId: "attach_h", ciphertext: Buffer.from("bytes:p/h").toString("base64") },
    ])
  })

  it("ships the stream's sealed turn digests oldest-first, skipping rows without ciphertext", async () => {
    arrangeClaim()
    const envelope = { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" }
    // Repo returns newest session first; the assignment must read oldest-first.
    spyOn(AgentSessionRepository, "findRecentDigestStepsByStream").mockResolvedValue([
      {
        step: {
          contentCiphertext: "bmV3",
          contentEnvelope: envelope,
          completedAt: new Date("2026-06-11T10:00:00.000Z"),
        },
        sessionCreatedAt: new Date("2026-06-11T09:59:00.000Z"),
        sessionCompletedAt: new Date("2026-06-11T10:00:00.000Z"),
      },
      {
        // Plaintext-shaped row (no ciphertext) must never ship to the enclave.
        step: { content: '{"findings":"x"}', contentCiphertext: null, contentEnvelope: null, completedAt: new Date() },
        sessionCreatedAt: new Date("2026-06-10T12:00:00.000Z"),
        sessionCompletedAt: new Date("2026-06-10T12:00:01.000Z"),
      },
      {
        step: {
          contentCiphertext: "b2xk",
          contentEnvelope: envelope,
          completedAt: new Date("2026-06-10T10:00:00.000Z"),
        },
        sessionCreatedAt: new Date("2026-06-10T09:59:00.000Z"),
        sessionCompletedAt: new Date("2026-06-10T10:00:00.000Z"),
      },
    ] as never)
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date(),
    } as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const assignment = await service().claimTurn("eik_live")

    expect(assignment!.recentDigests).toEqual([
      { ciphertext: "b2xk", envelope, completedAt: "2026-06-10T10:00:00.000Z" },
      { ciphertext: "bmV3", envelope, completedAt: "2026-06-11T10:00:00.000Z" },
    ])
  })

  it("ships the prior sealed rolling summary with its cursor and the deepened window budget (C-2)", async () => {
    arrangeClaim()
    const envelope = { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" }
    spyOn(ConversationSummaryRepository, "findByStreamAndPersona").mockResolvedValue({
      id: "agsum_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: agents.ARIADNE_AGENT_ID,
      summary: null,
      sealed: { ciphertext: "c3VtbWFyeQ==", envelope, keyGeneration: 1 },
      lastSummarizedSequence: 17n,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never)
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date(),
    } as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const assignment = await service().claimTurn("eik_live")

    expect(assignment!.priorSummary).toEqual({ ciphertext: "c3VtbWFyeQ==", envelope })
    expect(assignment!.summaryCursor).toBe("17")
    expect(assignment!.maxChars).toBe(agents.DEFAULT_CONTEXT_WINDOW_CHARS)
  })

  it("omits the prior summary (cursor-free) but still ships the window budget when no summary exists yet", async () => {
    arrangeClaim()
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date(),
    } as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const assignment = await service().claimTurn("eik_live")

    expect(assignment).not.toHaveProperty("priorSummary")
    expect(assignment).not.toHaveProperty("summaryCursor")
    expect(assignment!.maxChars).toBe(agents.DEFAULT_CONTEXT_WINDOW_CHARS)
  })

  it("returns null without claiming when the queue is empty", async () => {
    spyOn(EnclaveInvocationsRepository, "parkExhausted").mockResolvedValue([])
    spyOn(EnclaveInvocationsRepository, "claimNext").mockResolvedValue(null)
    const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip")

    expect(await service().claimTurn("eik_live")).toBeNull()
    expect(insertSession).not.toHaveBeenCalled()
  })

  it("fails loudly — leaving the row claimed for the TTL to recycle — when the wraps no longer cover the claiming key", async () => {
    const { completeClaimed } = arrangeClaim()
    // The claim predicate proved coverage moments ago, but the wrap was revoked
    // between claim and build (rotation race): never a silent skip, and no
    // session row for a turn no runner will drive.
    spyOn(StreamE2eKeyWrapsRepository, "listForStream").mockResolvedValue([{ ...WRAP, recipientKeyId: "eik_dead" }])
    const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip")

    await expect(service().claimTurn("eik_live")).rejects.toThrow(/no longer covers/)
    expect(insertSession).not.toHaveBeenCalled()
    expect(completeClaimed).not.toHaveBeenCalled() // claimed, not completed — retryable
  })

  it("completes the claim as a no-op and keeps claiming when the one-running guard skips the session", async () => {
    const { completeClaimed, claimNext } = arrangeClaim()
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(null)
    const insertEvent = spyOn(StreamEventRepository, "insert")

    expect(await service().claimTurn("eik_live")).toBeNull()

    expect(insertEvent).not.toHaveBeenCalled()
    expect(completeClaimed).toHaveBeenCalledWith(pool, "einv_1")
    // The loop went back for the next item (and found the queue empty).
    expect(claimNext).toHaveBeenCalledTimes(2)
  })

  it("completes the claim as a no-op when the trigger already has a live (fresh-heartbeat) or completed session", async () => {
    const { completeClaimed } = arrangeClaim()
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue({
      id: "session_prior",
      status: agents.SessionStatuses.RUNNING,
      heartbeatAt: new Date(), // fresh — genuinely being driven elsewhere
    } as never)
    const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip")

    expect(await service().claimTurn("eik_live")).toBeNull()
    expect(insertSession).not.toHaveBeenCalled()
    expect(completeClaimed).toHaveBeenCalledWith(pool, "einv_1")
  })

  it("defers — leaving the claim to its TTL — when the trigger's RUNNING session looks runnerless (stale heartbeat)", async () => {
    const { completeClaimed, claimNext } = arrangeClaim()
    // A lost claim response: the session row exists but nothing heartbeats it.
    // Completing the invocation would silently drop the turn; orphan cleanup is
    // about to fail the session, after which a later claim re-assigns it.
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue({
      id: "session_prior",
      status: agents.SessionStatuses.RUNNING,
      heartbeatAt: new Date(Date.now() - 120_000),
    } as never)
    const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip")

    expect(await service().claimTurn("eik_live")).toBeNull()
    expect(insertSession).not.toHaveBeenCalled()
    expect(completeClaimed).not.toHaveBeenCalled()
    expect(claimNext).toHaveBeenCalledTimes(1) // defer ends the poll, no spin
  })

  it("re-assigns a fresh session when the trigger's prior session FAILED", async () => {
    arrangeClaim()
    spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue({
      id: "session_prior",
      status: agents.SessionStatuses.FAILED,
    } as never)
    const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_2",
      createdAt: new Date(),
    } as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const assignment = await service().claimTurn("eik_live")
    expect(assignment).not.toBeNull()
    expect(insertSession).toHaveBeenCalledTimes(1)
  })
})

describe("enqueueEnclaveInvocation wake-up nudge", () => {
  const enqueueParams = {
    workspaceId: "ws_1",
    streamId: "stream_1",
    rootStreamId: "stream_1",
    messageId: "msg_trigger",
    triggeredBy: "usr_kris",
  }

  it("rings the doorbell after a fresh insert so a parked long-poll reacts now", async () => {
    spyOn(EnclaveInvocationsRepository, "insertPending").mockResolvedValue(true)
    const query = mock(async (_sql: string) => ({}) as never)
    const db = { query } as unknown as Pool

    await enqueueEnclaveInvocation(db, enqueueParams)

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain(`NOTIFY ${ENCLAVE_INVOCATION_CHANNEL}`)
  })

  it("stays silent when the trigger was a redelivery (no new row, no needless wake)", async () => {
    spyOn(EnclaveInvocationsRepository, "insertPending").mockResolvedValue(false)
    const query = mock(async (_sql: string) => ({}) as never)
    const db = { query } as unknown as Pool

    await enqueueEnclaveInvocation(db, enqueueParams)

    expect(query).not.toHaveBeenCalled()
  })

  it("rings the doorbell when the catch-up reopen produced fresh work", async () => {
    spyOn(EnclaveInvocationsRepository, "insertOrReopen").mockResolvedValue(true)
    const query = mock(async (_sql: string) => ({}) as never)
    const db = { query } as unknown as Pool

    await enqueueEnclaveInvocation(db, { ...enqueueParams, reopen: true })

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain(`NOTIFY ${ENCLAVE_INVOCATION_CHANNEL}`)
  })

  it("stays silent when the reopen left a live row untouched (turn already on its way)", async () => {
    spyOn(EnclaveInvocationsRepository, "insertOrReopen").mockResolvedValue(false)
    const query = mock(async (_sql: string) => ({}) as never)
    const db = { query } as unknown as Pool

    await enqueueEnclaveInvocation(db, { ...enqueueParams, reopen: true })

    expect(query).not.toHaveBeenCalled()
  })
})

describe("EnclaveClaimService re-wrap nudge sweep", () => {
  /** Stub the claim poll so it does nothing but run the nudge sweep, with one unservable stream. */
  function arrangeNudge(createdAt: Date) {
    spyOn(EnclaveInvocationsRepository, "parkExhausted").mockResolvedValue([])
    spyOn(EnclaveInvocationsRepository, "claimNext").mockResolvedValue(null)
    spyOn(EnclaveInvocationsRepository, "findUnservablePending").mockResolvedValue([
      { id: "einv_stuck", workspaceId: "ws_1", rootStreamId: "stream_root", ownerUserId: "usr_owner", createdAt },
    ])
    const tx = { __tx: true } as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    return { insertOutbox }
  }

  it("nudges the owner of a stuck stream over the socket immediately, holding web-push for the grace window", async () => {
    spyOn(EnclaveRewrapNotificationsRepository, "claimSocketNudge").mockResolvedValue(true)
    const webpush = spyOn(EnclaveRewrapNotificationsRepository, "claimWebpushNudge").mockResolvedValue(true)
    // Just enqueued — inside the web-push grace window.
    const { insertOutbox } = arrangeNudge(new Date())

    await service().claimTurn("eik_fresh")

    const types = insertOutbox.mock.calls.map((c) => c[1])
    expect(types).toContain("enclave:rewrap_needed")
    // Grace not yet elapsed → the web-push slot is never even claimed.
    expect(webpush).not.toHaveBeenCalled()
    expect(types).not.toContain("enclave:rewrap_nudge")
    // The signal carries the owner + the root the heal targets — never plaintext.
    const socketCall = insertOutbox.mock.calls.find((c) => c[1] === "enclave:rewrap_needed")!
    expect(socketCall[2]).toEqual({ workspaceId: "ws_1", targetUserId: "usr_owner", rootStreamId: "stream_root" })
  })

  it("escalates to a web-push once the stuck turn has outlived the grace window", async () => {
    spyOn(EnclaveRewrapNotificationsRepository, "claimSocketNudge").mockResolvedValue(true)
    spyOn(EnclaveRewrapNotificationsRepository, "claimWebpushNudge").mockResolvedValue(true)
    // Stuck for five minutes — past the two-minute grace.
    const { insertOutbox } = arrangeNudge(new Date(Date.now() - 5 * 60 * 1000))

    await service().claimTurn("eik_fresh")

    const types = insertOutbox.mock.calls.map((c) => c[1])
    expect(types).toContain("enclave:rewrap_needed")
    expect(types).toContain("enclave:rewrap_nudge")
  })

  it("stays silent on a channel another poller already claimed within its window (dedup)", async () => {
    spyOn(EnclaveRewrapNotificationsRepository, "claimSocketNudge").mockResolvedValue(false)
    spyOn(EnclaveRewrapNotificationsRepository, "claimWebpushNudge").mockResolvedValue(false)
    const { insertOutbox } = arrangeNudge(new Date(Date.now() - 5 * 60 * 1000))

    await service().claimTurn("eik_fresh")

    expect(insertOutbox).not.toHaveBeenCalled()
  })

  it("never lets a nudge failure break the claim poll", async () => {
    spyOn(EnclaveInvocationsRepository, "parkExhausted").mockResolvedValue([])
    spyOn(EnclaveInvocationsRepository, "claimNext").mockResolvedValue(null)
    spyOn(EnclaveInvocationsRepository, "findUnservablePending").mockRejectedValue(new Error("db down"))

    const result = await service().claimTurn("eik_fresh")

    expect(result).toBeNull()
  })
})
