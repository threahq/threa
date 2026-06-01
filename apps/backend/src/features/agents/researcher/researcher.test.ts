import { describe, expect, test, mock } from "bun:test"
import { WorkspaceAgent, type WorkspaceAgentDeps, type WorkspaceAgentInput } from "./researcher"
import type { Pool } from "pg"
import type { AI } from "@threa/agent-runtime"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import type { EmbeddingServiceLike } from "../../memos"

/**
 * Build a stub WorkspaceAgent dep set sufficient to exercise the abort-before-work
 * path. The pool's `connect` is never reached on the abort path, so we can leave
 * most fields as no-op stubs.
 */
function buildAgent(): WorkspaceAgent {
  const ai = {} as AI
  const configResolver = {
    resolve: mock(async () => ({
      modelId: "openrouter:anthropic/claude-haiku-4.5",
      temperature: 0.1,
      maxIterations: 2,
    })),
  } as unknown as ConfigResolver
  const embeddingService = {
    embed: mock(async () => []),
  } as unknown as EmbeddingServiceLike
  const pool = {
    connect: mock(async () => {
      throw new Error("pool.connect should not be called when aborted before work")
    }),
  } as unknown as Pool

  const deps: WorkspaceAgentDeps = { pool, ai, configResolver, embeddingService }
  return new WorkspaceAgent(deps)
}

describe("WorkspaceAgent abort/deadline checkpoints", () => {
  test("returns partial result with user_abort reason when signal is already aborted", async () => {
    const agent = buildAgent()
    const controller = new AbortController()
    controller.abort()

    const result = await agent.search({
      workspaceId: "ws_1",
      streamId: "stream_1",
      query: "What did we decide?",
      conversationHistory: [],
      invokingUserId: "user_1",
      signal: controller.signal,
    })

    expect(result.partial).toBe(true)
    expect(result.partialReason).toBe("user_abort")
    expect(result.memos).toHaveLength(0)
    expect(result.messages).toHaveLength(0)
  })

  test("returns partial result with timeout reason when deadlineAt has already passed", async () => {
    const agent = buildAgent()

    const result = await agent.search({
      workspaceId: "ws_1",
      streamId: "stream_1",
      query: "What did we decide?",
      conversationHistory: [],
      invokingUserId: "user_1",
      deadlineAt: Date.now() - 1, // already past
    })

    expect(result.partial).toBe(true)
    expect(result.partialReason).toBe("timeout")
  })

  test("partial result includes the access-check substep", async () => {
    const agent = buildAgent()
    const controller = new AbortController()
    controller.abort()

    const result = await agent.search({
      workspaceId: "ws_1",
      streamId: "stream_1",
      query: "What did we decide?",
      conversationHistory: [],
      invokingUserId: "user_1",
      signal: controller.signal,
    })

    // The first emitSubstep call ("Checking workspace access…") fires before the
    // abort check, so it's recorded. Then buildPartialResult appends the "Stopped…"
    // substep. We expect both.
    expect(result.substeps.length).toBeGreaterThanOrEqual(2)
    expect(result.substeps[0]?.text).toContain("Checking workspace access")
    expect(result.substeps.at(-1)?.text).toContain("Stopped on user request")
  })

  test("emits substeps via the onSubstep callback in lockstep with the persistent log", async () => {
    const agent = buildAgent()
    const controller = new AbortController()
    controller.abort()
    const onSubstep = mock((_text: string) => {})

    const result = await agent.search({
      workspaceId: "ws_1",
      streamId: "stream_1",
      query: "q",
      conversationHistory: [],
      invokingUserId: "user_1",
      signal: controller.signal,
      onSubstep,
    })

    // The "Checking workspace access…" substep is emitted via the helper,
    // which calls onSubstep AND pushes to the log. The "Stopped…" substep
    // is appended only to the log (not via onSubstep) because the loop is
    // already exiting at that point.
    expect(onSubstep).toHaveBeenCalledTimes(1)
    expect(onSubstep.mock.calls[0]?.[0]).toContain("Checking workspace access")
    expect(result.substeps[0]?.text).toBe(onSubstep.mock.calls[0]?.[0])
  })

  test("makePerCallSignal clamps per-call timeout to remaining deadline (PR #333 regression)", async () => {
    // Regression for PR #333 review finding: planRetrieval/evaluateResults were
    // casting { signal } as WorkspaceAgentInput, dropping deadlineAt and letting the
    // full per-call cap apply even when the total budget was nearly exhausted.
    const agent = buildAgent()

    // Reach the now-internal-API helper. This is a deliberate white-box test of the
    // deadline-clamping contract — the public path (planRetrieval/evaluateResults)
    // requires a full pool+AI stub to exercise.
    const makePerCallSignal = (
      agent as unknown as {
        makePerCallSignal: (
          p: { signal: AbortSignal | undefined; deadlineAt: number | undefined },
          perCallMs: number
        ) => { signal: AbortSignal; cleanup: () => void }
      }
    ).makePerCallSignal.bind(agent)

    // deadlineAt is 50ms from now; perCallMs is 30_000. Effective timeout should
    // clamp to ~50ms, not 30_000ms.
    const deadlineAt = Date.now() + 50
    const { signal, cleanup } = makePerCallSignal({ signal: undefined, deadlineAt }, 30_000)

    try {
      expect(signal.aborted).toBe(false)
      // Wait past the deadline — the composed signal should fire.
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(signal.aborted).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("makePerCallSignal fires synchronously when deadline is already past", () => {
    const agent = buildAgent()
    const makePerCallSignal = (
      agent as unknown as {
        makePerCallSignal: (
          p: { signal: AbortSignal | undefined; deadlineAt: number | undefined },
          perCallMs: number
        ) => { signal: AbortSignal; cleanup: () => void }
      }
    ).makePerCallSignal.bind(agent)

    const { signal, cleanup } = makePerCallSignal({ signal: undefined, deadlineAt: Date.now() - 100 }, 30_000)
    try {
      expect(signal.aborted).toBe(true)
    } finally {
      cleanup()
    }
  })
})

/**
 * White-box tests for the configurable iteration loop.
 *
 * The loop is hard to drive end-to-end because the entry point goes through
 * `withClient` + repository calls + real AI. Instead we monkey-patch the
 * private seams (`planRetrieval`, `evaluateResults`, `executeQueries`) on a
 * concrete agent instance and call `runSearchLoop` directly. This proves the
 * structural property the refactor was meant to enable: `maxIterations` linearly
 * controls how many refinement passes the loop runs.
 */
describe("WorkspaceAgent runSearchLoop iteration count", () => {
  type Plan = { reasoning: string; queries: Array<{ target: "memos"; type: "semantic"; query: string }> }
  type Eval = {
    sufficient: boolean
    additionalQueries: Array<{ target: "memos"; type: "semantic"; query: string }> | null
    reasoning: string
  }

  function buildAgentWithMaxIterations(maxIterations: number) {
    const ai = {} as AI
    const configResolver = {
      resolve: mock(async () => ({
        modelId: "openrouter:anthropic/claude-haiku-4.5",
        temperature: 0.1,
        maxIterations,
      })),
    } as unknown as ConfigResolver
    const embeddingService = {} as unknown as EmbeddingServiceLike
    const pool = {} as unknown as Pool
    return new WorkspaceAgent({ pool, ai, configResolver, embeddingService })
  }

  /**
   * Drive `runSearchLoop` directly with stubbed seams.
   *
   * - planRetrieval returns one fake query so iteration 1 has work.
   * - executeQueries always returns one fake memo, so iteration 1 finds results
   *   and the short-circuit doesn't fire.
   * - evaluateResults returns sufficient=false with one *new* query each call,
   *   forcing the loop to keep going up to `maxIterations`.
   */
  function stubAgent(agent: WorkspaceAgent, opts: { sufficientAfter?: number } = {}) {
    let evalCalls = 0
    let planCalls = 0
    let executeCalls = 0
    let queryCounter = 0

    const planRetrieval = mock(async (): Promise<Plan> => {
      planCalls++
      return { reasoning: "plan", queries: [{ target: "memos", type: "semantic", query: `plan-${queryCounter++}` }] }
    })

    const evaluateResults = mock(async (): Promise<Eval> => {
      evalCalls++
      const sufficient = opts.sufficientAfter !== undefined && evalCalls >= opts.sufficientAfter
      return {
        sufficient,
        additionalQueries: sufficient ? null : [{ target: "memos", type: "semantic", query: `eval-${queryCounter++}` }],
        reasoning: "eval",
      }
    })

    const executeQueries = mock(async () => {
      executeCalls++
      return {
        memos: [
          {
            memo: {
              id: `memo_${executeCalls}`,
              title: "t",
              abstract: "a",
              keyPoints: [],
              sourceMessageIds: [],
            },
            distance: 0,
            sourceStream: null,
          } as unknown as never,
        ],
        messages: [],
        attachments: [],
      }
    })

    // Patch instance methods (white-box). The cast mirrors the existing
    // makePerCallSignal pattern in this file.
    const writableAgent = agent as unknown as {
      planRetrieval: typeof planRetrieval
      evaluateResults: typeof evaluateResults
      executeQueries: typeof executeQueries
    }
    writableAgent.planRetrieval = planRetrieval
    writableAgent.evaluateResults = evaluateResults
    writableAgent.executeQueries = executeQueries

    return { planRetrieval, evaluateResults, executeQueries, getCounts: () => ({ evalCalls, executeCalls, planCalls }) }
  }

  function runLoop(agent: WorkspaceAgent, input: Partial<WorkspaceAgentInput> = {}) {
    const runSearchLoop = (
      agent as unknown as {
        runSearchLoop: (
          pool: Pool,
          input: WorkspaceAgentInput,
          accessSpec: { type: "all_streams" },
          accessibleStreamIds: string[],
          substeps: Array<{ text: string; at: string }>
        ) => Promise<unknown>
      }
    ).runSearchLoop.bind(agent)

    const fullInput: WorkspaceAgentInput = {
      workspaceId: "ws_1",
      streamId: "stream_1",
      query: "what did we decide",
      conversationHistory: [],
      invokingUserId: "user_1",
      ...input,
    }

    return runSearchLoop({} as Pool, fullInput, { type: "all_streams" }, ["stream_1"], [])
  }

  test("maxIterations=1 runs the bootstrap pass and skips the refinement loop entirely", async () => {
    const agent = buildAgentWithMaxIterations(1)
    const stubs = stubAgent(agent)

    await runLoop(agent)

    expect(stubs.planRetrieval).toHaveBeenCalledTimes(1)
    expect(stubs.evaluateResults).not.toHaveBeenCalled()
    // Bootstrap calls executeQueries once for planner-only queries (baseline path
    // is empty when buildBaselineQueries returns nothing for our test query).
    expect(stubs.getCounts().executeCalls).toBeGreaterThanOrEqual(1)
  })

  test("maxIterations=3 runs evaluator twice when each pass keeps requesting more", async () => {
    const agent = buildAgentWithMaxIterations(3)
    const stubs = stubAgent(agent)

    await runLoop(agent)

    // Refinement passes = maxIterations - 1 = 2; each pass invokes the evaluator
    // once and (when not sufficient) executeQueries once.
    expect(stubs.evaluateResults).toHaveBeenCalledTimes(2)
  })

  test("loop exits early when the evaluator returns sufficient=true", async () => {
    const agent = buildAgentWithMaxIterations(5)
    const stubs = stubAgent(agent, { sufficientAfter: 2 })

    await runLoop(agent)

    // Despite maxIterations=5 (4 refinement passes available), the loop should
    // stop after the second evaluator call returns sufficient.
    expect(stubs.evaluateResults).toHaveBeenCalledTimes(2)
  })
})

describe("WorkspaceAgent abort/deadline checkpoints (continued)", () => {
  test("non-aborted, non-timed-out call proceeds past the early checkpoint", async () => {
    // Use a pool stub that throws a recognizable error AFTER the abort check —
    // this proves the abort gate is permissive when no abort/deadline is set.
    const ai = {} as AI
    const configResolver = {
      resolve: mock(async () => ({
        modelId: "openrouter:anthropic/claude-haiku-4.5",
        temperature: 0.1,
        maxIterations: 2,
      })),
    } as unknown as ConfigResolver
    const embeddingService = {} as unknown as EmbeddingServiceLike
    const pool = {
      connect: mock(async () => {
        throw new Error("REACHED_POOL")
      }),
    } as unknown as Pool

    const agent = new WorkspaceAgent({ pool, ai, configResolver, embeddingService })

    let caught: unknown
    try {
      await agent.search({
        workspaceId: "ws_1",
        streamId: "stream_1",
        query: "q",
        conversationHistory: [],
        invokingUserId: "user_1",
      })
    } catch (err) {
      caught = err
    }

    expect((caught as Error)?.message).toContain("REACHED_POOL")
  })
})
