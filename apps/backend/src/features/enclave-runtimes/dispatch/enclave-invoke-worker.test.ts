import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import * as db from "../../../db"
import * as agents from "../../agents"
import { AgentSessionRepository } from "../../agents"
import { StreamRepository, StreamEventRepository, StreamPoliciesRepository } from "../../streams"
import { OutboxRepository } from "../../../lib/outbox"
import { E2eStreamActorsRepository, E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../../e2e-streams"
import type { E2eStream, E2eStreamActor, StreamE2eKeyWrap } from "../../e2e-streams"
import { MessageRepository } from "../../messaging"
import { AttachmentRepository } from "../../attachments"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import type { Message } from "../../messaging"
import { UserRepository } from "../../workspaces"
import { UserPreferencesService } from "../../user-preferences"
import { EnclaveRuntimesRepository, type EnclaveRuntime } from "../repository"
import type { EnclaveForwarder } from "../forwarder"
import { createEnclaveInvokeWorker } from "./enclave-invoke-worker"

const pool = {} as Pool
const JOB = { data: { workspaceId: "ws_1", streamId: "stream_1", messageId: "msg_trigger" } } as never

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
const EIK: EnclaveRuntime = {
  id: "elr_1",
  instanceId: "enci_1",
  keyId: "eik_live",
  publicKey: new Uint8Array([1, 2, 3]),
  instanceUrl: "https://enclave-1.internal",
  registeredAt: new Date(),
  lastSeenAt: new Date(),
  revokedAt: null,
}
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

function fakeIo() {
  const emit = mock((_event: string, _payload: unknown) => {})
  const io = { to: mock((_room: string) => ({ emit })) } as unknown as Server
  return { io, emit }
}

/** Stub everything up to the enclave handoff; returns the sentinel tx withTransaction runs on. */
function arrangeDispatch() {
  spyOn(E2eStreamsRepository, "getByStreamId").mockResolvedValue(E2E)
  spyOn(E2eStreamActorsRepository, "listForStream").mockResolvedValue([ENCLAVE_ACTOR])
  spyOn(AgentSessionRepository, "findByTriggerMessage").mockResolvedValue(null)
  spyOn(MessageRepository, "findById").mockResolvedValue(TRIGGER)
  spyOn(EnclaveRuntimesRepository, "listLive").mockResolvedValue([EIK])
  spyOn(StreamE2eKeyWrapsRepository, "listForStream").mockResolvedValue([WRAP])
  spyOn(MessageRepository, "findSurrounding").mockResolvedValue([])
  spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
  spyOn(AgentSessionRepository, "findRecentDigestStepsByStream").mockResolvedValue([])
  spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" } as never)
  spyOn(StreamPoliciesRepository, "getToolPolicy").mockResolvedValue(null)
  spyOn(UserPreferencesService.prototype, "getPreferences").mockResolvedValue({} as never)
  spyOn(UserRepository, "findByIds").mockResolvedValue([{ name: "Kris" }] as never)
  spyOn(agents, "buildEnclaveSystemPrompt").mockResolvedValue("You are Ariadne.")

  const tx = { __tx: true } as never
  spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
    fn(tx)) as never)
  return tx
}

describe("createEnclaveInvokeWorker", () => {
  it("commits the session row and the started lifecycle event in one transaction (INV-7)", async () => {
    const tx = arrangeDispatch()
    const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date("2026-06-02T09:27:01.000Z"),
    } as never)
    const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    const assignSession = mock(async () => {})
    const { io } = fakeIo()

    const worker = createEnclaveInvokeWorker({
      pool,
      io,
      enclaveForwarder: { assignSession } as unknown as EnclaveForwarder,
      storage: FAKE_STORAGE,
    })
    await worker(JOB)

    // Both writes ran on the same transaction client — a crash between them can't
    // leave a RUNNING session with no started event (invisible to the stream view
    // yet blocking the one-running guard).
    expect(insertSession.mock.calls[0]![0]).toBe(tx)
    expect(insertEvent.mock.calls[0]![0]).toBe(tx)
    expect(insertEvent.mock.calls[0]![1]).toMatchObject({
      streamId: "stream_1",
      eventType: "agent_session:started",
      payload: { personaId: agents.ARIADNE_AGENT_ID, triggerMessageId: "msg_trigger" },
    })
    expect(insertOutbox.mock.calls[0]![0]).toBe(tx)
    expect(insertOutbox.mock.calls[0]![1]).toBe("agent_session:started")
    expect(assignSession).toHaveBeenCalledTimes(1)
  })

  it("resolves the SSK + wraps from the root for a thread message (reply still lands in the thread)", async () => {
    arrangeDispatch()
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
    const assignSession = mock(async (_instanceUrl: string, _assignment: unknown) => {})
    const { io } = fakeIo()

    const worker = createEnclaveInvokeWorker({
      pool,
      io,
      enclaveForwarder: { assignSession } as unknown as EnclaveForwarder,
      storage: FAKE_STORAGE,
    })
    await worker(JOB)

    // Key material (e2e row + wraps) and the tool policy are fetched against the root...
    expect(getE2e).toHaveBeenCalledWith(pool, "ws_1", "stream_root")
    expect(listWraps).toHaveBeenCalledWith(pool, "ws_1", "stream_root")
    expect(getPolicy).toHaveBeenCalledWith(pool, "ws_1", "stream_root")
    // ...the assignment carries the root id, so the enclave unwraps under the
    // AAD the wraps were sealed with...
    const assignment = assignSession.mock.calls[0]![1] as { streamId: string }
    expect(assignment.streamId).toBe("stream_root")
    // ...but the session (and therefore Ariadne's reply) lands in the thread.
    expect(insertSession.mock.calls[0]![1]).toMatchObject({ streamId: "stream_1" })
  })

  it("threads the stream's tool-privacy policy from stream_policies onto the assignment", async () => {
    arrangeDispatch()
    spyOn(StreamPoliciesRepository, "getToolPolicy").mockResolvedValue(["web"])
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date(),
    } as never)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    const assignSession = mock(async (_instanceUrl: string, _assignment: unknown) => {})
    const { io } = fakeIo()

    const worker = createEnclaveInvokeWorker({
      pool,
      io,
      enclaveForwarder: { assignSession } as unknown as EnclaveForwarder,
      storage: FAKE_STORAGE,
    })
    await worker(JOB)

    const assignment = assignSession.mock.calls[0]![1] as { allowedToolCategories?: unknown }
    expect(assignment.allowedToolCategories).toEqual(["web"])
  })

  it("ships attachment ciphertext for the trigger AND recent history, trigger first", async () => {
    arrangeDispatch()
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
    const assignSession = mock(async (_instanceUrl: string, _assignment: unknown) => {})
    const { io } = fakeIo()

    const worker = createEnclaveInvokeWorker({
      pool,
      io,
      enclaveForwarder: { assignSession } as unknown as EnclaveForwarder,
      storage: { getObject } as unknown as StorageProvider,
    })
    await worker(JOB)

    const assignment = assignSession.mock.calls[0]![1] as { attachmentCiphertexts?: unknown }
    expect(assignment.attachmentCiphertexts).toEqual([
      { attachmentId: "attach_t", ciphertext: Buffer.from("bytes:p/t").toString("base64") },
      { attachmentId: "attach_h", ciphertext: Buffer.from("bytes:p/h").toString("base64") },
    ])
  })

  it("ships the stream's sealed turn digests oldest-first, skipping rows without ciphertext", async () => {
    arrangeDispatch()
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
    const assignSession = mock(async (_instanceUrl: string, _assignment: unknown) => {})
    const { io } = fakeIo()

    const worker = createEnclaveInvokeWorker({
      pool,
      io,
      enclaveForwarder: { assignSession } as unknown as EnclaveForwarder,
      storage: FAKE_STORAGE,
    })
    await worker(JOB)

    const assignment = assignSession.mock.calls[0]![1] as { recentDigests?: unknown }
    expect(assignment.recentDigests).toEqual([
      { ciphertext: "b2xk", envelope, completedAt: "2026-06-10T10:00:00.000Z" },
      { ciphertext: "bmV3", envelope, completedAt: "2026-06-11T10:00:00.000Z" },
    ])
  })

  it("parks the turn (throws for queue retry) when no live EIK holds the stream's wrap", async () => {
    arrangeDispatch()
    // The enclave restarted: the only wrap on file addresses a dead EIK, so the
    // live one can't open the trigger. The turn must park on the queue's
    // retry/backoff (the owner's client revives the wrap meanwhile) — never a
    // silent skip, and no session row before a servable enclave exists.
    spyOn(StreamE2eKeyWrapsRepository, "listForStream").mockResolvedValue([{ ...WRAP, recipientKeyId: "eik_dead" }])
    const insertSession = spyOn(AgentSessionRepository, "insertRunningOrSkip")
    const assignSession = mock(async () => {})
    const { io } = fakeIo()

    const worker = createEnclaveInvokeWorker({
      pool,
      io,
      enclaveForwarder: { assignSession } as unknown as EnclaveForwarder,
      storage: FAKE_STORAGE,
    })
    await expect(worker(JOB)).rejects.toThrow(/parking turn for retry/)

    expect(insertSession).not.toHaveBeenCalled()
    expect(assignSession).not.toHaveBeenCalled()
  })

  it("emits no started event when the one-running guard skips the session", async () => {
    arrangeDispatch()
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(null)
    const insertEvent = spyOn(StreamEventRepository, "insert")
    const assignSession = mock(async () => {})
    const { io } = fakeIo()

    const worker = createEnclaveInvokeWorker({
      pool,
      io,
      enclaveForwarder: { assignSession } as unknown as EnclaveForwarder,
      storage: FAKE_STORAGE,
    })
    await worker(JOB)

    expect(insertEvent).not.toHaveBeenCalled()
    expect(assignSession).not.toHaveBeenCalled()
  })

  it("fails the session with the full lifecycle when the enclave handoff fails", async () => {
    arrangeDispatch()
    spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue({
      id: "session_1",
      createdAt: new Date("2026-06-02T09:27:01.000Z"),
    } as never)
    const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    // The helper's internals: RUNNING→FAILED transition won, steps counted.
    const update = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue({ id: "session_1" } as never)
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])
    const assignSession = mock(async () => {
      throw new Error("enclave unreachable")
    })
    const { io, emit } = fakeIo()

    const worker = createEnclaveInvokeWorker({
      pool,
      io,
      enclaveForwarder: { assignSession } as unknown as EnclaveForwarder,
      storage: FAKE_STORAGE,
    })
    // The original assign error still propagates so the job retries.
    await expect(worker(JOB)).rejects.toThrow("enclave unreachable")

    // The started card must terminate: orphan-cleanup only scans RUNNING sessions,
    // so a session marked FAILED here gets no backstop emission.
    expect(update.mock.calls[0]![3]).toMatchObject({ error: "Enclave assignment failed" })
    const failedEvent = insertEvent.mock.calls.find(
      (c) => (c[1] as { eventType: string }).eventType === "agent_session:failed"
    )
    expect(failedEvent?.[1]).toMatchObject({
      streamId: "stream_1",
      eventType: "agent_session:failed",
      payload: { sessionId: "session_1", error: "Enclave assignment failed" },
    })
    // And a live-open trace dialog hears it directly via the session room.
    expect(io.to).toHaveBeenCalledWith("ws:ws_1:agent_session:session_1")
    expect(emit.mock.calls.some((c) => c[0] === "agent_session:failed")).toBe(true)
  })
})
