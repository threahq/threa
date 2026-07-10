import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { JobQueues, type QueueManager, type PersonaAgentJobData } from "../../lib/queue"
import { StreamEventRepository } from "../streams"
import { createPersonaAgentWorker, type PersonaAgentLike } from "./persona-agent-worker"
import type { PersonaAgentInput, PersonaAgentResult } from "./persona-agent"

function makeAgent(capture: (input: PersonaAgentInput) => void): PersonaAgentLike {
  return {
    run: async (input) => {
      capture(input)
      // Skipped avoids the post-completion checkForUnseenMessages path (which
      // would need a real pool); this test only cares that run() gets the input.
      return { sessionId: null, messagesSent: 0, sentMessageIds: [], status: "skipped" } satisfies PersonaAgentResult
    },
  }
}

function makeCompletedAgent(result: Partial<PersonaAgentResult>): PersonaAgentLike {
  return {
    run: async () =>
      ({
        sessionId: "session_1",
        messagesSent: 1,
        sentMessageIds: ["msg_agent_1"],
        status: "completed",
        lastSeenSequence: 10n,
        streamId: "stream_1",
        personaId: "persona_ariadne",
        ...result,
      }) satisfies PersonaAgentResult,
  }
}

describe("createPersonaAgentWorker", () => {
  it("maps a fired-follow-up job payload to a follow_up purpose", async () => {
    let captured: PersonaAgentInput | undefined
    const worker = createPersonaAgentWorker({
      agent: makeAgent((input) => (captured = input)),
      serverId: "srv_1",
      pool: {} as Pool,
      jobQueue: {} as QueueManager,
    })

    const data: PersonaAgentJobData = {
      workspaceId: "ws_1",
      streamId: "stream_1",
      messageId: "followup_agfu_01",
      personaId: "persona_ariadne",
      triggeredBy: "system",
      followUpId: "agfu_01",
    }
    await worker({ id: "job_1", name: "persona.agent", data })

    expect(captured?.purpose).toEqual({ kind: "follow_up", followUpId: "agfu_01" })
    expect(captured?.messageId).toBe("followup_agfu_01")
  })

  it("maps a plain companion job payload to a catch_up purpose", async () => {
    let captured: PersonaAgentInput | undefined
    const worker = createPersonaAgentWorker({
      agent: makeAgent((input) => (captured = input)),
      serverId: "srv_1",
      pool: {} as Pool,
      jobQueue: {} as QueueManager,
    })

    const data: PersonaAgentJobData = {
      workspaceId: "ws_1",
      streamId: "stream_1",
      messageId: "msg_1",
      personaId: "persona_ariadne",
      triggeredBy: "user",
    }
    await worker({ id: "job_2", name: "persona.agent", data })

    expect(captured?.purpose).toEqual({ kind: "catch_up" })
  })

  describe("episode-summary enqueue on completion (roadmap 3.1)", () => {
    afterEach(() => mock.restore())

    const baseData: PersonaAgentJobData = {
      workspaceId: "ws_1",
      streamId: "stream_1",
      messageId: "msg_1",
      personaId: "persona_ariadne",
      triggeredBy: "user",
    }

    it("enqueues an episode-summary job when a completed session replied", async () => {
      // No unseen messages, so the follow-up nudge stays out of the way.
      spyOn(StreamEventRepository, "getLatestUserMessageSequence").mockResolvedValue(null)
      const send = mock((_q: unknown, _d: unknown) => Promise.resolve("queue_1"))
      const worker = createPersonaAgentWorker({
        agent: makeCompletedAgent({ messagesSent: 2 }),
        serverId: "srv_1",
        pool: {} as Pool,
        jobQueue: { send } as unknown as QueueManager,
      })

      await worker({ id: "job_3", name: "persona.agent", data: baseData })

      expect(send).toHaveBeenCalledWith(JobQueues.AGENT_EPISODE_SUMMARIZE, {
        workspaceId: "ws_1",
        sessionId: "session_1",
      })
    })

    it("does not enqueue an episode summary when the completed session sent no messages", async () => {
      spyOn(StreamEventRepository, "getLatestUserMessageSequence").mockResolvedValue(null)
      const send = mock((_q: unknown, _d: unknown) => Promise.resolve("queue_1"))
      const worker = createPersonaAgentWorker({
        agent: makeCompletedAgent({ messagesSent: 0, sentMessageIds: [] }),
        serverId: "srv_1",
        pool: {} as Pool,
        jobQueue: { send } as unknown as QueueManager,
      })

      await worker({ id: "job_4", name: "persona.agent", data: baseData })

      const episodeCalls = send.mock.calls.filter((c) => c[0] === JobQueues.AGENT_EPISODE_SUMMARIZE)
      expect(episodeCalls).toHaveLength(0)
    })

    it("enqueues a reflective-capture job on completion even when the session sent no messages", async () => {
      // Reflective capture must cover the replyless research turn the episode gate
      // above skips (roadmap 6.3) — the service self-gates on research residue.
      spyOn(StreamEventRepository, "getLatestUserMessageSequence").mockResolvedValue(null)
      const send = mock((_q: unknown, _d: unknown) => Promise.resolve("queue_1"))
      const worker = createPersonaAgentWorker({
        agent: makeCompletedAgent({ messagesSent: 0, sentMessageIds: [] }),
        serverId: "srv_1",
        pool: {} as Pool,
        jobQueue: { send } as unknown as QueueManager,
      })

      await worker({ id: "job_5", name: "persona.agent", data: baseData })

      expect(send).toHaveBeenCalledWith(JobQueues.AGENT_REFLECTIVE_CAPTURE, {
        workspaceId: "ws_1",
        sessionId: "session_1",
      })
    })
  })
})
