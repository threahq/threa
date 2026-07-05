import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import type { AI } from "@threa/agent-runtime"
import type { Message } from "../messaging"
import { MessageRepository } from "../messaging"
import { AgentSessionRepository, SessionStatuses, type AgentSession } from "./session-repository"
import { EpisodeSummaryService } from "./episode-summary-service"

const MODEL_ID = "openrouter:openai/gpt-5.4-mini"

function makeSession(overrides?: Partial<AgentSession>): AgentSession {
  return {
    id: "session_1",
    streamId: "stream_1",
    personaId: "persona_1",
    triggerMessageId: "msg_trigger_1",
    triggerMessageRevision: null,
    supersedesSessionId: null,
    status: SessionStatuses.COMPLETED,
    currentStep: 0,
    currentStepType: null,
    serverId: null,
    callbackTokenHash: null,
    replyKeyGeneration: null,
    heartbeatAt: null,
    abortRequestedAt: null,
    responseMessageId: "msg_agent_1",
    error: null,
    lastSeenSequence: 10n,
    sentMessageIds: ["msg_agent_1"],
    contextMessageIds: [],
    episodeSummary: null,
    responseValidationFailed: false,
    createdAt: new Date("2026-06-10T09:00:00.000Z"),
    completedAt: new Date("2026-06-10T09:05:00.000Z"),
    ...overrides,
  }
}

function makeMessage(id: string, content: string): Message {
  return {
    id,
    streamId: "stream_1",
    sequence: 1n,
    authorId: "usr_1",
    authorType: "user",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: content,
    replyCount: 0,
    reactions: {},
    metadata: {},
    conversationIntent: null,
    clientMessageId: null,
    sentVia: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-06-10T09:00:00.000Z"),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
  }
}

describe("EpisodeSummaryService", () => {
  afterEach(() => mock.restore())

  function makeAI() {
    const generateText = mock((_opts: unknown) =>
      Promise.resolve({
        value: "Investigated the deploy cadence and concluded deploys happen Fridays only.",
        response: {} as never,
        usage: {},
      })
    )
    const ai = { generateText } as unknown as AI
    return { ai, generateText }
  }

  function makeService(ai: AI) {
    return new EpisodeSummaryService({
      pool: {} as Pool,
      ai,
      modelId: MODEL_ID,
      temperature: 0.1,
      maxTokens: 256,
    })
  }

  test("summarizes a completed session and persists the model output via the CAS", async () => {
    const { ai, generateText } = makeAI()
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(makeSession())
    spyOn(MessageRepository, "findById").mockResolvedValue(makeMessage("msg_trigger_1", "how often do we deploy?"))
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([["msg_agent_1", makeMessage("msg_agent_1", "We deploy on Fridays only.")]])
    )
    const setSpy = spyOn(AgentSessionRepository, "setEpisodeSummary").mockResolvedValue(true)

    const result = await makeService(ai).summarize({ workspaceId: "ws_1", sessionId: "session_1" })

    expect(result).toEqual({ written: true })
    expect(generateText).toHaveBeenCalledTimes(1)
    // INV-19: every AI wrapper call carries telemetry.
    const opts = generateText.mock.calls[0][0] as { telemetry?: { functionId?: string }; context?: unknown }
    expect(opts.telemetry?.functionId).toBe("agent.episode-summary")
    expect(opts.context).toMatchObject({ workspaceId: "ws_1", sessionId: "session_1", origin: "system" })
    expect(setSpy).toHaveBeenCalledWith(
      expect.anything(),
      "session_1",
      "Investigated the deploy cadence and concluded deploys happen Fridays only."
    )
  })

  test("no-ops without an AI call when the session already has a summary", async () => {
    const { ai, generateText } = makeAI()
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(makeSession({ episodeSummary: "already summarized" }))
    const setSpy = spyOn(AgentSessionRepository, "setEpisodeSummary")

    const result = await makeService(ai).summarize({ workspaceId: "ws_1", sessionId: "session_1" })

    expect(result).toEqual({ written: false })
    expect(generateText).not.toHaveBeenCalled()
    expect(setSpy).not.toHaveBeenCalled()
  })

  test("no-ops when the session is not completed", async () => {
    const { ai, generateText } = makeAI()
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(makeSession({ status: SessionStatuses.RUNNING }))

    const result = await makeService(ai).summarize({ workspaceId: "ws_1", sessionId: "session_1" })

    expect(result).toEqual({ written: false })
    expect(generateText).not.toHaveBeenCalled()
  })

  test("no-ops when the session row is gone", async () => {
    const { ai, generateText } = makeAI()
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(null)

    const result = await makeService(ai).summarize({ workspaceId: "ws_1", sessionId: "missing" })

    expect(result).toEqual({ written: false })
    expect(generateText).not.toHaveBeenCalled()
  })

  test("survives a synthetic follow-up trigger with no real message row", async () => {
    const { ai, generateText } = makeAI()
    spyOn(AgentSessionRepository, "findById").mockResolvedValue(makeSession({ triggerMessageId: "followup_agfu_1" }))
    // Synthetic follow-up trigger id resolves to no message.
    spyOn(MessageRepository, "findById").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([["msg_agent_1", makeMessage("msg_agent_1", "Checked back in as promised.")]])
    )
    spyOn(AgentSessionRepository, "setEpisodeSummary").mockResolvedValue(true)

    const result = await makeService(ai).summarize({ workspaceId: "ws_1", sessionId: "session_1" })

    expect(result).toEqual({ written: true })
    expect(generateText).toHaveBeenCalledTimes(1)
  })
})
