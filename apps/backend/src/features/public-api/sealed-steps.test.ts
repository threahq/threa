import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { THREA_CALLBACK_TOKEN_HEADER } from "@threa/types"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"
import { StreamRepository } from "../streams"
import { AgentSessionRepository, hashCallbackToken, type AgentSession, type AgentSessionStep } from "../agents"
import * as dbModule from "../../db"

// Phase 2 sealed bot `/steps` + `/steps/started`: the external sibling of the
// enclave's session-callback steps. A sealed-capable bot harness streams sealed
// trace steps back; the server persists ciphertext it can't read and broadcasts
// the live trace frames. Auth is the bot API key + the neutral
// `X-Threa-Callback-Token` header verified against the session's binding.

const CALLBACK_TOKEN = "tok_1"
const REPLY_ENVELOPE = { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" }

const session: AgentSession = {
  id: "binv_1",
  streamId: "stream_thread",
  personaId: "bot_1",
  triggerMessageId: "msg_trigger",
  triggerMessageRevision: null,
  supersedesSessionId: null,
  status: "running",
  currentStep: 0,
  currentStepType: null,
  serverId: null,
  callbackTokenHash: hashCallbackToken(CALLBACK_TOKEN),
  replyKeyGeneration: 3,
  heartbeatAt: new Date("2026-06-12T09:00:00.000Z"),
  abortRequestedAt: null,
  responseMessageId: null,
  error: null,
  lastSeenSequence: 0n,
  sentMessageIds: [],
  contextMessageIds: [],
  createdAt: new Date("2026-06-12T09:00:00.000Z"),
  completedAt: null,
}

function stepRow(overrides: Partial<AgentSessionStep>): AgentSessionStep {
  return {
    id: "step_1",
    sessionId: "binv_1",
    stepNumber: 1,
    stepType: "thinking",
    content: null,
    contentCiphertext: "c2VhbGVk",
    contentEnvelope: REPLY_ENVELOPE,
    sources: null,
    messageId: null,
    tokensUsed: null,
    startedAt: new Date("2026-06-12T09:00:01.000Z"),
    completedAt: null,
    ...overrides,
  }
}

function createResponse() {
  const payloads: unknown[] = []
  const res = {} as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock((body: unknown) => {
    payloads.push(body)
    return res
  }) as unknown as Response["json"]
  return { res, payloads }
}

function createEmitSpy() {
  const emitted: { room: string; event: string; payload: unknown }[] = []
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ room, event, payload })
      },
    }),
  } as unknown as PublicApiDeps["io"]
  return { io, emitted }
}

function arrange(sessionOverride?: Partial<AgentSession>) {
  spyOn(AgentSessionRepository, "findById").mockResolvedValue({ ...session, ...sessionOverride } as never)
  spyOn(StreamRepository, "findById").mockResolvedValue({
    id: "stream_thread",
    workspaceId: "ws_1",
  } as never)
  spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", name: "Pi", archivedAt: null } as never)
  spyOn(dbModule, "withTransaction").mockImplementation(((_pool: unknown, fn: (c: unknown) => unknown) =>
    fn({})) as never)
  spyOn(AgentSessionRepository, "updateCurrentStepType").mockResolvedValue(undefined as never)

  const { io, emitted } = createEmitSpy()
  const handlers = createPublicApiHandlers({
    eventService: {} as PublicApiDeps["eventService"],
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
    pool: {} as PublicApiDeps["pool"],
    io,
  })
  return { handlers, emitted }
}

function req(
  body: Record<string, unknown>,
  headers: Record<string, string> = { [THREA_CALLBACK_TOKEN_HEADER]: CALLBACK_TOKEN }
) {
  return {
    workspaceId: "ws_1",
    botApiKey: { botId: "bot_1" },
    params: { invocationId: "binv_1" },
    header: (name: string) => headers[name],
    body,
  } as unknown as Request
}

describe("startBotInvocationSealedStep", () => {
  afterEach(() => mock.restore())

  it("persists the in-flight sealed step and broadcasts the started frame", async () => {
    const { handlers, emitted } = arrange()
    const append = spyOn(AgentSessionRepository, "appendStep").mockResolvedValue(stepRow({}) as never)
    const { res, payloads } = createResponse()

    await handlers.startBotInvocationSealedStep(
      req({ stepId: "step_1", stepType: "thinking", ciphertext: "c2VhbGVk", envelope: REPLY_ENVELOPE }),
      res
    )

    const appendParams = append.mock.calls[0]?.[1] as unknown as Record<string, unknown>
    expect(appendParams).toMatchObject({
      id: "step_1",
      sessionId: "binv_1",
      stepType: "thinking",
      contentCiphertext: "c2VhbGVk",
      contentEnvelope: REPLY_ENVELOPE,
    })
    expect(appendParams.completedAt).toBeUndefined()
    expect(emitted.map((e) => e.event)).toContain("agent_session:step:started")
    expect((payloads[0] as { data: { stepId: string } }).data.stepId).toBe("step_1")
  })

  it("rejects a missing callback token (403)", async () => {
    const { handlers } = arrange()
    const { res } = createResponse()
    await expect(
      handlers.startBotInvocationSealedStep(
        req({ stepId: "step_1", stepType: "thinking", ciphertext: "c2VhbGVk", envelope: REPLY_ENVELOPE }, {}),
        res
      )
    ).rejects.toMatchObject({ status: 403, code: "CALLBACK_TOKEN_MISSING" })
  })

  it("rejects a mismatched callback token (403)", async () => {
    const { handlers } = arrange()
    const { res } = createResponse()
    await expect(
      handlers.startBotInvocationSealedStep(
        req(
          { stepId: "step_1", stepType: "thinking", ciphertext: "c2VhbGVk", envelope: REPLY_ENVELOPE },
          {
            [THREA_CALLBACK_TOKEN_HEADER]: "wrong",
          }
        ),
        res
      )
    ).rejects.toMatchObject({ status: 403, code: "CALLBACK_TOKEN_MISMATCH" })
  })

  it("rejects a non-running session (409)", async () => {
    const { handlers } = arrange({ status: "completed" })
    const { res } = createResponse()
    await expect(
      handlers.startBotInvocationSealedStep(
        req({ stepId: "step_1", stepType: "thinking", ciphertext: "c2VhbGVk", envelope: REPLY_ENVELOPE }),
        res
      )
    ).rejects.toMatchObject({ status: 409, code: "SESSION_NOT_RUNNING" })
  })

  it("rejects a seal under the wrong key generation (400)", async () => {
    const { handlers } = arrange()
    spyOn(AgentSessionRepository, "appendStep").mockResolvedValue(stepRow({}) as never)
    const { res } = createResponse()
    await expect(
      handlers.startBotInvocationSealedStep(
        req({
          stepId: "step_1",
          stepType: "thinking",
          ciphertext: "c2VhbGVk",
          envelope: { ...REPLY_ENVELOPE, keyGeneration: 4 },
        }),
        res
      )
    ).rejects.toMatchObject({ status: 400, code: "E2E_WRONG_KEY_GENERATION" })
  })
})

describe("recordBotInvocationSealedStep", () => {
  afterEach(() => mock.restore())

  it("finalizes the in-flight step in place and broadcasts the completed frame", async () => {
    const { handlers, emitted } = arrange()
    const completed = stepRow({ completedAt: new Date("2026-06-12T09:00:05.000Z") })
    const update = spyOn(AgentSessionRepository, "updateStep").mockResolvedValue(completed as never)
    const append = spyOn(AgentSessionRepository, "appendStep").mockResolvedValue(completed as never)
    const { res, payloads } = createResponse()

    await handlers.recordBotInvocationSealedStep(
      req({ stepId: "step_1", stepType: "thinking", ciphertext: "c2VhbGVk", envelope: REPLY_ENVELOPE }),
      res
    )

    const updateParams = update.mock.calls[0]?.[2] as unknown as Record<string, unknown>
    expect(updateParams).toMatchObject({ contentCiphertext: "c2VhbGVk", contentEnvelope: REPLY_ENVELOPE })
    expect(updateParams.completedAt).toBeInstanceOf(Date)
    // No fallback insert when the in-flight row was finalized.
    expect(append).not.toHaveBeenCalled()
    expect(emitted.map((e) => e.event)).toContain("agent_session:step:completed")
    expect((payloads[0] as { data: { stepId: string } }).data.stepId).toBe("step_1")
  })

  it("falls back to a completed insert when the start POST was dropped", async () => {
    const { handlers, emitted } = arrange()
    spyOn(AgentSessionRepository, "updateStep").mockResolvedValue(null as never)
    const inserted = stepRow({ completedAt: new Date("2026-06-12T09:00:05.000Z") })
    const append = spyOn(AgentSessionRepository, "appendStep").mockResolvedValue(inserted as never)
    const { res } = createResponse()

    await handlers.recordBotInvocationSealedStep(
      req({
        stepId: "step_1",
        stepType: "thinking",
        ciphertext: "c2VhbGVk",
        envelope: REPLY_ENVELOPE,
        durationMs: 200,
      }),
      res
    )

    const appendParams = append.mock.calls[0]?.[1] as unknown as Record<string, unknown>
    expect(appendParams).toMatchObject({ id: "step_1", contentCiphertext: "c2VhbGVk" })
    expect(appendParams.completedAt).toBeInstanceOf(Date)
    // The fallback advances the inline indicator (progress) plus the completed frame.
    expect(emitted.map((e) => e.event)).toEqual(
      expect.arrayContaining(["agent_session:progress", "agent_session:step:completed"])
    )
  })
})
