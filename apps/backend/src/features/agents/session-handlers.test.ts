import { describe, test, expect, afterEach, spyOn, mock } from "bun:test"
import type { Pool } from "pg"
import { createAgentSessionHandlers } from "./session-handlers"
import { AgentSessionRepository } from "./session-repository"
import { PersonaRepository } from "./persona-repository"
import { BotRepository } from "../public-api"
import { StreamEventRepository } from "../streams"
import * as streamsModule from "../streams"

const SESSION = {
  id: "session_1",
  streamId: "thread_1",
  personaId: "persona_1",
  triggerMessageId: "msg_1",
  triggerMessageRevision: null,
  supersedesSessionId: null,
  status: "running",
  currentStepType: null,
  sentMessageIds: [],
  createdAt: new Date("2026-07-09T10:00:00.000Z"),
  completedAt: null,
} as never

const THREAD_STREAM = {
  id: "thread_1",
  workspaceId: "ws_1",
  rootStreamId: "stream_dm_1",
} as never

const STEP = {
  id: "step_1",
  sessionId: "session_1",
  stepNumber: 1,
  stepType: "thinking",
  content: undefined,
  contentCiphertext: null,
  contentEnvelope: null,
  sources: null,
  messageId: null,
  tokensUsed: null,
  startedAt: new Date("2026-07-09T10:00:01.000Z"),
  completedAt: new Date("2026-07-09T10:00:02.000Z"),
} as never

function mockReq() {
  return {
    user: { id: "usr_viewer" },
    workspaceId: "ws_1",
    params: { sessionId: "session_1" },
  } as never
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(data: unknown) {
      res.body = data
      return res
    },
  }
  return res
}

function stubCommonReads() {
  spyOn(AgentSessionRepository, "findById").mockResolvedValue(SESSION)
  spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([STEP])
  spyOn(AgentSessionRepository, "listByTriggerMessage").mockResolvedValue([SESSION])
  spyOn(PersonaRepository, "findById").mockResolvedValue({
    id: "persona_1",
    name: "Ariadne",
    avatarEmoji: null,
  } as never)
  spyOn(BotRepository, "findById").mockResolvedValue(null)
  spyOn(StreamEventRepository, "listRerunContextBySessionIds").mockResolvedValue(new Map())
}

afterEach(() => {
  mock.restore()
})

describe("getSession access (INV-62)", () => {
  test("grants a viewer with inherited thread access (no direct thread membership row)", async () => {
    stubCommonReads()
    // The canonical predicate resolves thread→root: a DM member reading a
    // thread they never posted in gets the root's access, not a 403.
    const accessSpy = spyOn(streamsModule, "checkStreamAccess").mockResolvedValue(THREAD_STREAM)

    const handlers = createAgentSessionHandlers({ pool: {} as Pool })
    const res = mockRes()
    await handlers.getSession(mockReq(), res as never)

    expect(accessSpy).toHaveBeenCalledWith(expect.anything(), "thread_1", "ws_1", "usr_viewer")
    expect(res.statusCode).toBe(200)
    expect((res.body as { steps: unknown[] }).steps).toHaveLength(1)
  })

  test("returns 404 when the canonical access check denies the viewer", async () => {
    stubCommonReads()
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue(null)

    const handlers = createAgentSessionHandlers({ pool: {} as Pool })
    const res = mockRes()
    await handlers.getSession(mockReq(), res as never)

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: "Session not found" })
  })
})

/**
 * The guardian's verdict is persisted on the step, but the trace badge reads it
 * from THIS response — and a serializer that lists fields by hand drops a new
 * one silently. That is exactly how it shipped once: DB row `approved`, live
 * socket patch correct, badge invisible on reload because the bootstrap never
 * carried it. Caught by a real browser run, not by any test, so this is the
 * test.
 */
describe("getSession carries the guardian verdict", () => {
  test("serializes `verification` for a guarded step", async () => {
    stubCommonReads()
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([
      { ...(STEP as object), verification: { status: "approved", reason: "The user asked for this." } },
    ] as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue(THREAD_STREAM)

    const handlers = createAgentSessionHandlers({ pool: {} as Pool })
    const res = mockRes()
    await handlers.getSession(mockReq(), res as never)

    const [step] = (res.body as { steps: Array<{ verification?: unknown }> }).steps
    expect(step!.verification).toEqual({ status: "approved", reason: "The user asked for this." })
  })

  test("leaves it absent on an unguarded step, so old traces render unchanged", async () => {
    stubCommonReads()
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue(THREAD_STREAM)

    const handlers = createAgentSessionHandlers({ pool: {} as Pool })
    const res = mockRes()
    await handlers.getSession(mockReq(), res as never)

    const [step] = (res.body as { steps: Array<{ verification?: unknown }> }).steps
    expect(step!.verification).toBeUndefined()
  })
})
