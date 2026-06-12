import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import * as db from "../../db"
import * as agents from "../agents"
import { AgentSessionRepository } from "../agents"
import { StreamRepository, StreamEventRepository, StreamPoliciesRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { hashCallbackToken } from "./callback-token"
import { E2eStreamActorsRepository, E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../e2e-streams"
import type { E2eStream, E2eStreamActor, StreamE2eKeyWrap } from "../e2e-streams"
import { MessageRepository } from "../messaging"
import { AttachmentRepository } from "../attachments"
import type { StorageProvider } from "../../lib/storage/s3-client"
import type { Message } from "../messaging"
import { UserRepository } from "../workspaces"
import type { UserPreferencesService } from "../user-preferences"
import { EnclaveInvocationsRepository, type EnclaveInvocation } from "./invocations-repository"
import { EnclaveClaimService } from "./claim-service"

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
  spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" } as never)
  spyOn(StreamPoliciesRepository, "getToolPolicy").mockResolvedValue(null)
  spyOn(UserRepository, "findByIds").mockResolvedValue([{ name: "Kris" }] as never)
  spyOn(agents, "buildEnclaveSystemPrompt").mockResolvedValue("You are Ariadne.")

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
