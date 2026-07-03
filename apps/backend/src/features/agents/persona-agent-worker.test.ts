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
  it("forwards followUpId from the fired-follow-up job to agent.run", async () => {
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

    expect(captured?.followUpId).toBe("agfu_01")
    expect(captured?.messageId).toBe("followup_agfu_01")
  })

  it("leaves followUpId undefined for a normal companion job", async () => {
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

    expect(captured?.followUpId).toBeUndefined()
  })
})
