import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import type { Message } from "../messaging"
import { MessageRepository } from "../messaging"
import { AgentSessionRepository, SessionStatuses, type AgentSession, type AgentSessionStep } from "./session-repository"
import { buildSessionDigest } from "./session-digest"

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
    reflectiveCapturedAt: null,
    createdAt: new Date("2026-06-10T09:00:00.000Z"),
    completedAt: new Date("2026-06-10T09:05:00.000Z"),
    ...overrides,
  }
}

function makeMessage(id: string, content: string, authorType = "user", authorId = "usr_1"): Message {
  return {
    id,
    streamId: "stream_1",
    sequence: 1n,
    authorId,
    authorType,
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
  } as Message
}

function digestStep(findings: string): AgentSessionStep {
  return {
    id: "step_1",
    sessionId: "session_1",
    stepNumber: 1,
    stepType: "turn_digest",
    content: { findings },
    contentCiphertext: null,
    contentEnvelope: null,
    sources: null,
    messageId: null,
    tokensUsed: null,
    startedAt: new Date("2026-06-10T09:01:00.000Z"),
    completedAt: new Date("2026-06-10T09:02:00.000Z"),
  }
}

describe("buildSessionDigest", () => {
  afterEach(() => mock.restore())

  test("assembles trigger + research findings + replies, anchoring to the real trigger", async () => {
    spyOn(MessageRepository, "findById").mockResolvedValue(makeMessage("msg_trigger_1", "how do we deploy?"))
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([
      digestStep("Deploys run Fridays after the smoke suite."),
    ])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([["msg_agent_1", makeMessage("msg_agent_1", "We deploy Fridays.", "persona", "persona_1")]])
    )

    const digest = await buildSessionDigest({} as Pool, makeSession())

    expect(digest).not.toBeNull()
    expect(digest!.hasResearch).toBe(true)
    expect(digest!.anchorMessageId).toBe("msg_trigger_1")
    // Only human authors count as participants; the persona reply doesn't.
    expect(digest!.participantUserIds).toEqual(["usr_1"])
    expect(digest!.text).toContain("Trigger message:")
    expect(digest!.text).toContain("What the assistant researched:")
    expect(digest!.text).toContain("What the assistant replied:")
  })

  test("flags hasResearch false and anchors to the last reply when the trigger is synthetic", async () => {
    // A fired follow-up: synthetic trigger id with no message row, no research.
    spyOn(MessageRepository, "findById").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])
    spyOn(MessageRepository, "findByIds").mockResolvedValue(
      new Map([["msg_agent_1", makeMessage("msg_agent_1", "Checked back in.", "persona", "persona_1")]])
    )

    const digest = await buildSessionDigest({} as Pool, makeSession({ triggerMessageId: "followup_agfu_1" }))

    expect(digest).not.toBeNull()
    expect(digest!.hasResearch).toBe(false)
    expect(digest!.anchorMessageId).toBe("msg_agent_1")
    expect(digest!.participantUserIds).toEqual([])
  })

  test("returns null when there is nothing to condense", async () => {
    spyOn(MessageRepository, "findById").mockResolvedValue(null)
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([])

    const digest = await buildSessionDigest({} as Pool, makeSession({ sentMessageIds: [] }))

    expect(digest).toBeNull()
  })
})
