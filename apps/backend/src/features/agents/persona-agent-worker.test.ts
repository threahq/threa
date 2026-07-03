import { describe, expect, it } from "bun:test"
import type { Pool } from "pg"
import type { QueueManager, PersonaAgentJobData } from "../../lib/queue"
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
})
