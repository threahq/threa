import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn, mock } from "bun:test"
import { Pool } from "pg"
import type { Server } from "socket.io"
import { withClient, setupTestDatabase } from "./setup"
import {
  AgentSessionRepository,
  SessionStatuses,
  TraceEmitter,
  createAgentSessionHandlers,
  PersonaRepository,
} from "../../src/features/agents"
import { BotRepository, serializeTraceStep } from "../../src/features/public-api"
import { StreamEventRepository } from "../../src/features/streams"
import * as streamsModule from "../../src/features/streams"
import { streamId, sessionId, personaId, messageId, stepId } from "../../src/lib/id"
import { AgentStepTypes, type AgentToolEffect } from "@threa/types"

const SETTINGS_EFFECTS: AgentToolEffect[] = [
  { kind: "settings", label: "Theme", target: "theme", before: "light", after: "dark" },
  { kind: "settings", label: "Timezone", target: "timezone", before: "Europe/Stockholm", after: "Asia/Tokyo" },
]

describe("agent step effects", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM agent_session_steps")
    await pool.query("DELETE FROM agent_sessions")
  })

  async function seedSession(client: Parameters<typeof AgentSessionRepository.insert>[0], id: string) {
    await AgentSessionRepository.insert(client, {
      id,
      streamId: streamId(),
      personaId: personaId(),
      triggerMessageId: messageId(),
      status: SessionStatuses.RUNNING,
    })
  }

  test("effects round-trip through updateStep and back out of the repo", async () => {
    const testSessionId = sessionId()
    const testStepId = stepId()

    await withClient(pool, async (client) => {
      await seedSession(client, testSessionId)
      await AgentSessionRepository.upsertStep(client, {
        id: testStepId,
        sessionId: testSessionId,
        stepNumber: 1,
        stepType: AgentStepTypes.TOOL_CALL,
        startedAt: new Date("2026-07-28T09:00:00Z"),
      })

      const patched = await AgentSessionRepository.updateStep(client, testStepId, { effects: SETTINGS_EFFECTS })
      expect(patched!.effects).toEqual(SETTINGS_EFFECTS)

      // Read back through a fresh SELECT, not the RETURNING row — the column has
      // to be in STEP_SELECT_FIELDS or the value exists but never loads.
      const [reloaded] = await AgentSessionRepository.findStepsBySession(client, testSessionId)
      expect(reloaded!.effects).toEqual(SETTINGS_EFFECTS)
    })
  })

  test("a read-only step has no effects rather than an empty array", async () => {
    const testSessionId = sessionId()

    await withClient(pool, async (client) => {
      await seedSession(client, testSessionId)
      await AgentSessionRepository.upsertStep(client, {
        id: stepId(),
        sessionId: testSessionId,
        stepNumber: 1,
        stepType: AgentStepTypes.WEB_SEARCH,
        startedAt: new Date(),
      })

      const [step] = await AgentSessionRepository.findStepsBySession(client, testSessionId)
      expect(step!.effects).toBeUndefined()
    })
  })

  // The verification columns shipped with this exact bug class: a retry reuses
  // step_number, so without an explicit reset attempt 2's step 1 inherits
  // attempt 1's row state — here, claiming writes this attempt never made.
  test("a retry does not inherit the previous attempt's effects", async () => {
    const testSessionId = sessionId()
    const testStepId = stepId()

    await withClient(pool, async (client) => {
      await seedSession(client, testSessionId)
      await AgentSessionRepository.upsertStep(client, {
        id: testStepId,
        sessionId: testSessionId,
        stepNumber: 1,
        stepType: AgentStepTypes.TOOL_CALL,
        startedAt: new Date("2026-07-28T09:00:00Z"),
      })
      await AgentSessionRepository.updateStep(client, testStepId, { effects: SETTINGS_EFFECTS })

      const retried = await AgentSessionRepository.upsertStep(client, {
        id: stepId(),
        sessionId: testSessionId,
        stepNumber: 1,
        stepType: AgentStepTypes.THINKING,
        startedAt: new Date("2026-07-28T09:05:00Z"),
      })

      expect(retried.effects).toBeUndefined()
    })
  })

  test("updateStep leaves existing effects alone when the patch omits them", async () => {
    const testSessionId = sessionId()
    const testStepId = stepId()

    await withClient(pool, async (client) => {
      await seedSession(client, testSessionId)
      await AgentSessionRepository.upsertStep(client, {
        id: testStepId,
        sessionId: testSessionId,
        stepNumber: 1,
        stepType: AgentStepTypes.TOOL_CALL,
        startedAt: new Date(),
      })
      await AgentSessionRepository.updateStep(client, testStepId, { effects: SETTINGS_EFFECTS })

      const completed = await AgentSessionRepository.updateStep(client, testStepId, { completedAt: new Date() })
      expect(completed!.effects).toEqual(SETTINGS_EFFECTS)
    })
  })

  /**
   * Three hand-written, field-by-field serializers stand between the column and
   * a viewer, and each drops an unlisted field in silence. The socket one is the
   * one that matters: without it the effects render after a reload but not live,
   * the mirror image of the guardian-badge bug this repo already shipped once.
   */
  describe("every serializer carries effects", () => {
    afterEach(() => {
      mock.restore()
    })

    async function seedStepWithEffects() {
      const testSessionId = sessionId()
      const testStepId = stepId()
      await seedSession(pool, testSessionId)
      await AgentSessionRepository.upsertStep(pool, {
        id: testStepId,
        sessionId: testSessionId,
        stepNumber: 1,
        stepType: AgentStepTypes.TOOL_CALL,
        startedAt: new Date("2026-07-28T09:00:00Z"),
      })
      await AgentSessionRepository.updateStep(pool, testStepId, {
        content: "done",
        effects: SETTINGS_EFFECTS,
        completedAt: new Date("2026-07-28T09:00:02Z"),
      })
      const [step] = await AgentSessionRepository.findStepsBySession(pool, testSessionId)
      return { sessionId: testSessionId, stepId: testStepId, step: step! }
    }

    test("getSession serializes them", async () => {
      const { sessionId: seededSessionId, step } = await seedStepWithEffects()
      spyOn(AgentSessionRepository, "findById").mockResolvedValue({
        id: seededSessionId,
        streamId: "thread_1",
        personaId: "persona_1",
        triggerMessageId: "msg_1",
        triggerMessageRevision: null,
        supersedesSessionId: null,
        status: "running",
        currentStepType: null,
        sentMessageIds: [],
        createdAt: new Date("2026-07-28T09:00:00Z"),
        completedAt: null,
      } as never)
      spyOn(AgentSessionRepository, "listByTriggerMessage").mockResolvedValue([])
      spyOn(PersonaRepository, "findById").mockResolvedValue({
        id: "persona_1",
        name: "Ariadne",
        avatarEmoji: null,
      } as never)
      spyOn(BotRepository, "findById").mockResolvedValue(null)
      spyOn(StreamEventRepository, "listRerunContextBySessionIds").mockResolvedValue(new Map())
      spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({
        id: "thread_1",
        workspaceId: "ws_1",
        rootStreamId: "stream_1",
      } as never)

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
      await createAgentSessionHandlers({ pool }).getSession(
        { user: { id: "usr_viewer" }, workspaceId: "ws_1", params: { sessionId: seededSessionId } } as never,
        res as never
      )

      const [serialized] = (res.body as { steps: unknown[] }).steps
      expect(serialized).toEqual({
        id: step.id,
        sessionId: seededSessionId,
        stepNumber: 1,
        stepType: AgentStepTypes.TOOL_CALL,
        content: "done",
        contentCiphertext: undefined,
        contentEnvelope: undefined,
        sources: undefined,
        messageId: undefined,
        tokensUsed: undefined,
        verification: undefined,
        effects: SETTINGS_EFFECTS,
        duration: 2000,
        startedAt: "2026-07-28T09:00:00.000Z",
        completedAt: "2026-07-28T09:00:02.000Z",
      })
    })

    test("serializeTraceStep serializes them", async () => {
      const { sessionId: seededSessionId, step } = await seedStepWithEffects()

      expect(serializeTraceStep(step)).toEqual({
        id: step.id,
        sessionId: seededSessionId,
        stepNumber: 1,
        stepType: AgentStepTypes.TOOL_CALL,
        content: "done",
        sources: undefined,
        messageId: undefined,
        tokensUsed: undefined,
        verification: undefined,
        effects: SETTINGS_EFFECTS,
        duration: 2000,
        startedAt: "2026-07-28T09:00:00.000Z",
        completedAt: "2026-07-28T09:00:02.000Z",
        contentCiphertext: undefined,
        contentEnvelope: undefined,
      })
    })

    test("the completed-step socket payload carries them", async () => {
      const testSessionId = sessionId()
      await seedSession(pool, testSessionId)

      const emits: Array<{ event: string; payload: Record<string, unknown> }> = []
      const io = {
        to: () => io,
        emit: (event: string, payload: Record<string, unknown>) => {
          emits.push({ event, payload })
        },
      } as unknown as Server

      const trace = new TraceEmitter({ io, pool }).forSession({
        sessionId: testSessionId,
        workspaceId: "ws_1",
        streamId: "stream_1",
        triggerMessageId: "msg_1",
        personaName: "Ariadne",
      })
      const active = await trace.startStep({ stepType: AgentStepTypes.TOOL_CALL })
      const [started] = await AgentSessionRepository.findStepsBySession(pool, testSessionId)
      await AgentSessionRepository.updateStep(pool, started!.id, { effects: SETTINGS_EFFECTS })
      await active.complete({ content: "done" })

      const [reloaded] = await AgentSessionRepository.findStepsBySession(pool, testSessionId)
      const completed = emits.find((e) => e.event === "agent_session:step:completed")
      expect(completed?.payload).toEqual({
        sessionId: testSessionId,
        step: {
          id: reloaded!.id,
          sessionId: testSessionId,
          stepNumber: 1,
          stepType: AgentStepTypes.TOOL_CALL,
          content: "done",
          sources: null,
          messageId: null,
          verification: undefined,
          effects: SETTINGS_EFFECTS,
          startedAt: reloaded!.startedAt.toISOString(),
          completedAt: reloaded!.completedAt!.toISOString(),
        },
      })
    })
  })
})
