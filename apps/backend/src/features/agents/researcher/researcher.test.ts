import { afterEach, describe, expect, test, mock, spyOn } from "bun:test"
import { WorkspaceAgent, type WorkspaceAgentDeps, type WorkspaceAgentInput } from "./researcher"
import {
  WORKSPACE_AGENT_MAX_PLANNED_QUERIES,
  WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
  WORKSPACE_AGENT_MAX_THREAD_RESULTS_PER_SEARCH,
} from "./config"
import { buildBaselineQueries, type BaselineQuery } from "./query/baseline-queries"
import type { Pool } from "pg"
import { SearchRepository } from "../../search"
import { AISpendDeniedError, type AI } from "@threahq/agent-runtime"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import type { EmbeddingServiceLike } from "../../memos"
import { UserRepository } from "../../workspaces"
import { MessageRepository, type Message } from "../../messaging"
import { StreamRepository, type Stream } from "../../streams"
import type { EnrichedMemoResult } from "./context-formatter"
import type { PeopleResolverLike } from "./people-resolver"
import { StubPeopleResolver } from "./people-resolver.stub"

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

  const deps: WorkspaceAgentDeps = {
    pool,
    ai,
    configResolver,
    embeddingService,
    peopleResolver: new StubPeopleResolver(),
  }
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
      searchFlag: "on",
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
      searchFlag: "on",
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
      searchFlag: "on",
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
      searchFlag: "on",
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
    // Regression for PR #333 review finding: planRetrieval was
    // casting { signal } as WorkspaceAgentInput, dropping deadlineAt and letting the
    // full per-call cap apply even when the total budget was nearly exhausted.
    const agent = buildAgent()

    // Reach the now-internal-API helper. This is a deliberate white-box test of the
    // deadline-clamping contract — the public path (planRetrieval)
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
 * White-box test of the search loop: the private seams (`planRetrieval`, `executeQueries`) are patched on a concrete
 * agent and `runSearchLoop` is called directly, since the entry point goes through `withClient` + repositories + AI.
 */
describe("WorkspaceAgent runSearchLoop", () => {
  afterEach(() => mock.restore())

  const planned = (...queries: string[]): BaselineQuery[] =>
    queries.map((query) => ({ target: "memos", type: "semantic", query }))

  function runLoop(options: {
    query: string
    people: string[]
    peopleResolver?: PeopleResolverLike
    queries?: BaselineQuery[]
    memos?: EnrichedMemoResult[]
    conversationHistory?: Array<{ id: string }>
  }) {
    const configResolver = {
      resolve: mock(async () => ({ modelId: "openrouter:anthropic/claude-haiku-4.5", temperature: 0.1 })),
    } as unknown as ConfigResolver
    const agent = new WorkspaceAgent({
      pool: {} as unknown as Pool,
      ai: {} as AI,
      configResolver,
      embeddingService: {} as unknown as EmbeddingServiceLike,
      peopleResolver: options.peopleResolver ?? new StubPeopleResolver(),
    })
    const planRetrieval = mock(async (_params: { contextSummary: string }) => ({
      reasoning: "plan",
      queries: options.queries ?? planned("plan-0"),
      people: options.people,
    }))
    const executeQueries = mock(
      async (_pool: Pool, _queries: Array<{ target: string; type: string; query: string; authorId?: string }>) => ({
        memos: options.memos ?? [],
        messages: [],
        attachments: [],
      })
    )
    Object.assign(agent, { planRetrieval, executeQueries })

    const runSearchLoop = (
      agent as unknown as {
        runSearchLoop: (
          pool: Pool,
          input: WorkspaceAgentInput,
          accessSpec: { type: "all_streams" },
          accessibleStreamIds: string[],
          roomStreamIds: string[],
          names: Map<string, { name: string; slug: string }>,
          substeps: Array<{ text: string; at: string }>
        ) => Promise<{ retrievedContext: string | null }>
      }
    ).runSearchLoop.bind(agent)
    const result = runSearchLoop(
      {} as Pool,
      {
        workspaceId: "ws_1",
        streamId: "stream_1",
        query: options.query,
        conversationHistory: (options.conversationHistory ?? []) as WorkspaceAgentInput["conversationHistory"],
        invokingUserId: "user_1",
        searchFlag: "on",
      },
      { type: "all_streams" },
      ["stream_1"],
      [],
      new Map([["user_1", { name: "Ada", slug: "ada" }]]),
      []
    )
    return { result, planRetrieval, executeQueries }
  }

  test("plans once and runs the planned queries once, capped after dropping repeats and baseline queries", async () => {
    const { result, planRetrieval, executeQueries } = runLoop({
      query: "what did we decide",
      people: [],
      queries: [
        ...buildBaselineQueries("what did we decide"),
        ...planned("plan-0", " PLAN-0", ...Array.from({ length: 7 }, (_, i) => `plan-${i + 1}`)),
      ],
    })
    await result

    const plannedRuns = executeQueries.mock.calls.filter(([, queries]) => queries.some((q) => q.query === "plan-0"))
    expect({
      plans: planRetrieval.mock.calls.length,
      plannedRuns: plannedRuns.map(([, queries]) => queries.map((q) => q.query)),
    }).toEqual({
      plans: 1,
      plannedRuns: [Array.from({ length: WORKSPACE_AGENT_MAX_PLANNED_QUERIES }, (_, i) => `plan-${i}`)],
    })
  })

  test("shows each retrieved memo's newest sources as related messages, skipping the conversation itself", async () => {
    const sourceIds = Array.from({ length: 7 }, (_, i) => `msg_0${i}`)
    const memo = {
      memo: {
        id: "memo_1",
        title: "Deploy runbook",
        abstract: "Deploys ship on Tuesday",
        keyPoints: [],
        sourceMessageIds: sourceIds,
        latestSourceAt: null,
      },
      distance: 0.1,
      sourceStream: { id: "stream_1", type: "channel", name: "General" },
    } as unknown as EnrichedMemoResult
    const findByIdsInStreams = spyOn(MessageRepository, "findByIdsInStreams").mockImplementation(
      async (_db, _workspaceId, ids) =>
        new Map(
          ids.map((id) => [
            id,
            {
              id,
              streamId: "stream_1",
              contentMarkdown: `${id} says Wednesday`,
              authorId: "user_1",
              authorType: "user",
              createdAt: new Date("2026-07-01T10:00:00Z"),
            } as unknown as Message,
          ])
        )
    )
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "user_1", name: "Ada" }] as never)
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      { id: "stream_1", type: "channel", displayName: "General" } as unknown as Stream,
    ])

    const { result } = runLoop({
      query: "when do we deploy",
      people: [],
      memos: [memo],
      conversationHistory: [{ id: "msg_06" }],
    })
    const { retrievedContext } = await result

    expect({
      fetched: findByIdsInStreams.mock.calls.map(([, workspaceId, ids, streamIds]) => ({
        workspaceId,
        ids,
        streamIds,
      })),
      related: retrievedContext?.match(/msg_0\d says Wednesday/g),
    }).toEqual({
      fetched: [
        { workspaceId: "ws_1", ids: ["msg_01", "msg_02", "msg_03", "msg_04", "msg_05"], streamIds: ["stream_1"] },
      ],
      related: [
        "msg_01 says Wednesday",
        "msg_02 says Wednesday",
        "msg_03 says Wednesday",
        "msg_04 says Wednesday",
        "msg_05 says Wednesday",
      ],
    })
  })

  test("tells the planner who is asking, searches what a resolved person wrote, and reports who each name is", async () => {
    const listByCircle = spyOn(UserRepository, "listByCircle").mockResolvedValue([])
    const resolve = mock(async () => [
      { reference: "Kate", status: "resolved" as const, person: { id: "user_kate", name: "Kate Moss", slug: "kate" } },
      {
        reference: "John",
        status: "ambiguous" as const,
        candidates: [
          { id: "user_john_a", name: "John Ash", slug: "john-a" },
          { id: "user_john_b", name: "John Birch", slug: "john-b" },
        ],
      },
    ])
    const { result, planRetrieval, executeQueries } = runLoop({
      query: "what did Kate tell John",
      people: ["Kate", "John"],
      peopleResolver: { resolve },
    })
    const { retrievedContext } = await result

    expect({
      askedBy: planRetrieval.mock.calls[0]![0].contextSummary.startsWith("## Asked by\nAda (@ada)"),
      rosterFor: listByCircle.mock.calls[0]![2].askerId,
      authorQueries: executeQueries.mock.calls.flatMap(([, queries]) => queries.filter((q) => q.authorId)),
      people: retrievedContext?.slice(retrievedContext.indexOf("## People")),
    }).toEqual({
      askedBy: true,
      rosterFor: "user_1",
      authorQueries: [
        { target: "messages", type: "semantic", query: "what did Kate tell John", authorId: "user_kate" },
      ],
      people: [
        "## People",
        "",
        '- "Kate" is Kate Moss (kate).',
        '- "John" could be John Ash (john-a) or John Birch (john-b). If the answer depends on which, ask which one is meant, naming them without @-mentions.',
      ].join("\n"),
    })
  })

  test("reports every named person as unresolved when the resolver cannot answer", async () => {
    spyOn(UserRepository, "listByCircle").mockResolvedValue([])
    const { result } = runLoop({
      query: "what did Kate decide",
      people: ["Kate"],
      peopleResolver: new StubPeopleResolver(),
    })
    const { retrievedContext } = await result

    expect(retrievedContext?.slice(retrievedContext.indexOf("## People"))).toBe(
      '## People\n\n- "Kate" could not be matched to anyone. They may still exist.'
    )
  })

  test("fails the search when the workspace's AI spend is denied while resolving people", async () => {
    spyOn(UserRepository, "listByCircle").mockResolvedValue([])
    const resolve = mock(async () => {
      throw new AISpendDeniedError({ workspaceId: "ws_1", functionId: "researcher-people" }, "workspace_limit")
    })
    const { result } = runLoop({ query: "what did Kate decide", people: ["Kate"], peopleResolver: { resolve } })

    await expect(result).rejects.toBeInstanceOf(AISpendDeniedError)
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
      })),
    } as unknown as ConfigResolver
    const embeddingService = {} as unknown as EmbeddingServiceLike
    const pool = {
      connect: mock(async () => {
        throw new Error("REACHED_POOL")
      }),
    } as unknown as Pool

    const agent = new WorkspaceAgent({
      pool,
      ai,
      configResolver,
      embeddingService,
      peopleResolver: new StubPeopleResolver(),
    })

    let caught: unknown
    try {
      await agent.search({
        workspaceId: "ws_1",
        streamId: "stream_1",
        query: "q",
        conversationHistory: [],
        invokingUserId: "user_1",
        searchFlag: "on",
      })
    } catch (err) {
      caught = err
    }

    expect((caught as Error)?.message).toContain("REACHED_POOL")
  })
})

describe("WorkspaceAgent searchMessages workspace scope", () => {
  afterEach(() => mock.restore())

  const emptyClient = { query: mock(async () => ({ rows: [], rowCount: 0 })), release: mock(() => {}) }
  const pool = { connect: mock(async () => emptyClient) } as unknown as Pool

  function searchMessages(embedding: number[], accessibleStreamIds = ["stream_1"]) {
    const agent = new WorkspaceAgent({
      pool,
      ai: {} as AI,
      configResolver: {} as ConfigResolver,
      embeddingService: { embed: mock(async () => embedding) } as unknown as EmbeddingServiceLike,
      peopleResolver: new StubPeopleResolver(),
    })
    return (agent as unknown as { searchMessages: (...args: unknown[]) => Promise<unknown> }).searchMessages(
      pool,
      { target: "messages", type: "semantic", query: "launch date" },
      "ws_1",
      accessibleStreamIds,
      [],
      false,
      new Set(),
      "improved"
    )
  }

  test("passes the invocation's workspace to the keyword-only search when there is no embedding", async () => {
    const fullTextSearch = spyOn(SearchRepository, "fullTextSearch").mockResolvedValue([])

    await searchMessages([])

    expect(fullTextSearch.mock.calls.map(([, params]) => params.workspaceId)).toEqual(["ws_1"])
  })

  test("passes the invocation's workspace to the hybrid search and to its keyword fallback", async () => {
    const hybridSearch = spyOn(SearchRepository, "hybridSearch").mockResolvedValue([])
    const fullTextSearch = spyOn(SearchRepository, "fullTextSearch").mockResolvedValue([])

    await searchMessages([0.1])

    expect(hybridSearch.mock.calls.map(([, params]) => params.workspaceId)).toEqual(["ws_1"])
    expect(fullTextSearch.mock.calls.map(([, params]) => params.workspaceId)).toEqual(["ws_1"])
  })

  test("searches inside the readable threads the hits open or sit in, skipping the hits themselves", async () => {
    const hit = (id: string, streamId: string) => ({
      id,
      streamId,
      content: "launch date moved",
      authorId: "user_1",
      authorType: "user" as const,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    const hybridSearch = spyOn(SearchRepository, "hybridSearch")
      .mockResolvedValueOnce([hit("msg_anchor", "stream_1"), hit("msg_reply", "stream_thread_b")] as never)
      .mockResolvedValue([])
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      { id: "stream_1", type: "channel", parentAnchorId: null },
      { id: "stream_thread_b", type: "thread", parentAnchorId: "msg_other" },
    ] as Stream[])
    const findThreadsByAnchorIds = spyOn(StreamRepository, "findThreadsByAnchorIds").mockResolvedValue([
      { id: "stream_thread_a", type: "thread", parentAnchorId: "msg_anchor" },
      { id: "stream_thread_unreadable", type: "thread", parentAnchorId: "msg_anchor" },
    ] as Stream[])

    const accessibleStreamIds = ["stream_1", "stream_thread_a", "stream_thread_b"]
    await searchMessages([0.1], accessibleStreamIds)

    expect({
      anchorLookup: findThreadsByAnchorIds.mock.calls[0].slice(1),
      searches: hybridSearch.mock.calls.map(([, params]) => ({ streamIds: params.streamIds, limit: params.limit })),
    }).toEqual({
      anchorLookup: ["ws_1", ["stream_1", "stream_thread_b"], ["msg_anchor", "msg_reply"]],
      searches: [
        { streamIds: accessibleStreamIds, limit: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH },
        { streamIds: ["stream_thread_b", "stream_thread_a"], limit: WORKSPACE_AGENT_MAX_THREAD_RESULTS_PER_SEARCH + 2 },
      ],
    })
  })
})
