import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AgentStepTypes } from "@threahq/types"
import { AgentSessionRepository, SessionStatuses } from "../../src/features/agents"
import { loadEpisodeSummaryPromptBlock } from "../../src/features/agents/companion/episode-summaries"
import { messageId, personaId, sessionId, stepId, streamId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"

describe("episode summaries: source stream access", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  /** A stream with three summarized sessions: one cited a shared channel, one a private one, one researched nothing. */
  async function seedSessions() {
    const ids = { streamId: streamId(), personaId: personaId(), shared: streamId(), private: streamId() }
    await seedSession(ids, "Answered from the shared channel.", [[ids.shared]])
    await seedSession(ids, "Answered from the private channel.", [[ids.shared], [ids.private]])
    await seedSession(ids, "Answered without research.", [])
    return ids
  }

  async function seedSession(
    ids: { streamId: string; personaId: string },
    summary: string,
    digestSourceStreamIds: string[][]
  ) {
    const id = sessionId()
    await AgentSessionRepository.insert(pool, {
      id,
      streamId: ids.streamId,
      personaId: ids.personaId,
      triggerMessageId: messageId(),
      status: SessionStatuses.COMPLETED,
    })
    for (const [stepNumber, sourceStreamIds] of digestSourceStreamIds.entries()) {
      await AgentSessionRepository.upsertStep(pool, {
        id: stepId(),
        sessionId: id,
        stepNumber,
        stepType: AgentStepTypes.TURN_DIGEST,
        content: { findings: "searched the workspace", toolsCalled: ["search"], sources: [], sourceStreamIds },
        startedAt: new Date(),
      })
    }
    await AgentSessionRepository.setEpisodeSummary(pool, id, summary)
  }

  async function injectedSummaries(
    ids: { streamId: string; personaId: string },
    accessibleStreamIds: Set<string> | null
  ): Promise<string[]> {
    const block = await loadEpisodeSummaryPromptBlock(pool, { ...ids, accessibleStreamIds })
    return (block ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- ["))
      .map((line) => line.replace(/^- \[[^\]]+\] /, ""))
  }

  test("a summary whose session cited a stream the viewer can't read is left out", async () => {
    const ids = await seedSessions()

    expect(await injectedSummaries(ids, new Set([ids.streamId, ids.shared]))).toEqual([
      "Answered from the shared channel.",
      "Answered without research.",
    ])
  })

  test("a turn with no invoking user sees only summaries that cite no streams", async () => {
    const ids = await seedSessions()

    expect(await injectedSummaries(ids, null)).toEqual(["Answered without research."])
  })
})
