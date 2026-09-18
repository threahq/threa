import { describe, test, expect, mock } from "bun:test"
import type { AI, DecisionQuestion, GenerateDecisionsOptions } from "@threahq/agent-runtime"
import type { AnyComponentConfig, ConfigResolver } from "../../../lib/ai/config-resolver"
import { DecisionsBoundaryExtractor } from "./decisions-extractor"
import type { ConversationSummary, ExtractionContext } from "./types"
import type { Message } from "../../messaging"

/**
 * One entry per question key: a number answers a noul (the belief) or a score
 * (the ladder index), a string picks a choice. Unanswered questions take the
 * neutral default — belief 0, the bottom rung, the first option — so a test
 * names only the answers it is about.
 */
type Answers = Record<string, number | string>

function createAI(answers: Answers, prose: { title: string | null; summary: string | null }) {
  const decisionCalls: GenerateDecisionsOptions[] = []
  const proseCalls: { messages: unknown }[] = []

  const generateDecisions = mock(async (options: GenerateDecisionsOptions) => {
    decisionCalls.push(options)
    const given = (key: string) => answers[key]
    const entries = Object.entries(options.questions as Record<string, DecisionQuestion>).map(([key, question]) => {
      const value = given(key)
      if (question.type === "noul") {
        return [key, { type: "noul", noul: typeof value === "number" ? value : 0 }] as const
      }
      if (question.type === "choice") {
        const choice = typeof value === "string" ? value : Object.keys(question.criteria)[0]
        return [key, { type: "choice", choice, probabilities: {}, confidence: 0.9 }] as const
      }
      return [
        key,
        {
          type: "score",
          score: typeof value === "number" ? value : 0,
          legend: Object.fromEntries(question.criteria.map((c, i) => [String(i), c])),
          probabilities: {},
          confidence: 0.9,
        },
      ] as const
    })
    return { answers: Object.fromEntries(entries), usage: {} }
  })

  const generateObject = mock(async (options: { messages: unknown }) => {
    proseCalls.push({ messages: options.messages })
    return { value: prose, response: { usage: {} }, usage: {} }
  })

  const ai = {
    generateDecisions: generateDecisions as unknown as AI["generateDecisions"],
    generateObject: generateObject as unknown as AI["generateObject"],
  } as AI

  return { ai, decisionCalls, proseCalls, generateDecisions, generateObject }
}

const configResolver: ConfigResolver = {
  async resolve<T extends AnyComponentConfig>(): Promise<T> {
    return { modelId: "openrouter:openai/gpt-5.6-luna", temperature: 0.2 } as T
  },
}

function message(overrides: Partial<Message> = {}): Message {
  const contentMarkdown = overrides.contentMarkdown ?? "Test message content"
  return {
    id: "msg_new",
    streamId: "stream_test",
    sequence: BigInt(1),
    authorId: "usr_test",
    authorType: "user",
    contentJson: { type: "doc", content: [] },
    contentMarkdown,
    replyCount: 0,
    reactions: {},
    metadata: {},
    conversationIntent: null,
    revision: 1,
    clientMessageId: null,
    sentVia: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-09-18T12:00:00Z"),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    ...overrides,
  }
}

function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "conv_a",
    topicSummary: "Deploy pipeline",
    summary: "Covers the staging deploy failing on migrations.",
    messageCount: 5,
    lastMessagePreview: "preview",
    participantIds: ["usr_test"],
    completenessScore: 3,
    status: "active",
    lastActivityAt: new Date("2026-09-18T11:58:00Z"),
    contextMessageIds: [],
    ...overrides,
  }
}

function context(overrides: Partial<ExtractionContext> = {}): ExtractionContext {
  return {
    newMessage: message(),
    recentMessages: [message({ id: "msg_old", contentMarkdown: "Earlier message" })],
    activeConversations: [conversation()],
    streamType: "scratchpad",
    workspaceId: "wsp_test",
    ...overrides,
  }
}

const NO_PROSE = { title: null, summary: null }

describe("DecisionsBoundaryExtractor", () => {
  test("answers a cold-start thread without calling any model", async () => {
    const { ai, generateDecisions, generateObject } = createAI({}, NO_PROSE)
    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(
      context({ streamType: "thread", activeConversations: [], newMessage: message({ contentMarkdown: "Kickoff" }) })
    )

    expect({
      result,
      decisionCalls: generateDecisions.mock.calls.length,
      proseCalls: generateObject.mock.calls.length,
    }).toEqual({
      result: {
        assignments: [{ conversationId: null, isPrimary: true }],
        newConversationTopic: "Kickoff",
        confidence: 1.0,
      },
      decisionCalls: 0,
      proseCalls: 0,
    })
  })

  test("names the stream's first conversation without a decision call", async () => {
    const { ai, generateDecisions } = createAI({}, { title: "Deploypipeline", summary: "Handlar om deployen." })
    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(
      context({ activeConversations: [] })
    )

    expect({ result, decisionCalls: generateDecisions.mock.calls.length }).toEqual({
      result: {
        assignments: [{ conversationId: null, isPrimary: true }],
        newConversationTopic: "Deploypipeline",
        newConversationSummary: "Handlar om deployen.",
        reassignments: undefined,
        confidence: 1.0,
      },
      decisionCalls: 0,
    })
  })

  test("places the message in the chosen conversation and rescales the completeness ladder", async () => {
    const { ai, generateObject } = createAI(
      { placement: "conv_a", "completeness::conv_a": 3, "status::conv_a": "resolved" },
      NO_PROSE
    )
    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(context())

    expect({ result, proseCalls: generateObject.mock.calls.length }).toEqual({
      result: {
        assignments: [{ conversationId: "conv_a", isPrimary: true }],
        reassignments: undefined,
        completenessUpdates: [{ conversationId: "conv_a", score: 7, status: "resolved", summary: undefined }],
        confidence: 0.9,
      },
      proseCalls: 0,
    })
  })

  test("the bottom rung of the ladder is the bottom of the completeness scale", async () => {
    const { ai } = createAI({ placement: "conv_a", "completeness::conv_a": 0 }, NO_PROSE)
    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(context())

    expect(result.completenessUpdates).toEqual([
      { conversationId: "conv_a", score: 1, status: "active", summary: undefined },
    ])
  })

  test("reports completeness for every candidate, not just the one the message joined", async () => {
    const ctx = context({ activeConversations: [conversation(), conversation({ id: "conv_b" })] })
    const { ai } = createAI(
      {
        placement: "conv_a",
        "completeness::conv_a": 3,
        "status::conv_a": "active",
        "completeness::conv_b": 3,
        "status::conv_b": "stalled",
      },
      NO_PROSE
    )

    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(ctx)

    expect(result.completenessUpdates).toEqual([
      { conversationId: "conv_a", score: 7, status: "active", summary: undefined },
      { conversationId: "conv_b", score: 7, status: "stalled" },
    ])
  })

  test("drops a status the model was never offered rather than overwriting the stored one", async () => {
    const { ai } = createAI({ placement: "conv_a", "status::conv_a": "abandoned" }, NO_PROSE)

    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(context())

    expect(result.completenessUpdates).toEqual([])
  })

  test("does not move earlier messages on a placement choice it cannot read", async () => {
    const ctx = context({
      recentMessages: [message({ id: "msg_stray", contentMarkdown: "Stray opener" })],
      activeConversations: [conversation({ contextMessageIds: ["msg_stray"] })],
    })
    const { ai } = createAI({ placement: "conv_nonexistent", "move::msg_stray": 0.99 }, NO_PROSE)

    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(ctx)

    expect({ assignments: result.assignments, reassignments: result.reassignments }).toEqual({
      assignments: [{ conversationId: null, isPrimary: true }],
      reassignments: undefined,
    })
  })

  test("refreshes the summary only when the stored one is called stale", async () => {
    const stale = createAI(
      { placement: "conv_a", "summary_stale::conv_a": 0.9 },
      { title: null, summary: "Nu handlar den om rollbacken." }
    )
    const fresh = createAI({ placement: "conv_a", "summary_stale::conv_a": 0.5 }, NO_PROSE)
    const extract = (ai: AI) => new DecisionsBoundaryExtractor(ai, configResolver).extract(context())

    const [staleResult, freshResult] = [await extract(stale.ai), await extract(fresh.ai)]

    expect({
      stale: staleResult.completenessUpdates?.[0]?.summary,
      staleProseCalls: stale.generateObject.mock.calls.length,
      fresh: freshResult.completenessUpdates?.[0]?.summary,
      freshProseCalls: fresh.generateObject.mock.calls.length,
    }).toEqual({
      stale: "Nu handlar den om rollbacken.",
      staleProseCalls: 1,
      fresh: undefined,
      freshProseCalls: 0,
    })
  })

  test("adds a secondary assignment only above the belief floor", async () => {
    const ctx = context({ activeConversations: [conversation(), conversation({ id: "conv_b" })] })
    const strong = createAI({ placement: "conv_a", "secondary::conv_b": 0.9 }, NO_PROSE)
    const weak = createAI({ placement: "conv_a", "secondary::conv_b": 0.7 }, NO_PROSE)
    const extract = (ai: AI) => new DecisionsBoundaryExtractor(ai, configResolver).extract(ctx)

    expect({
      strong: (await extract(strong.ai)).assignments,
      weak: (await extract(weak.ai)).assignments,
    }).toEqual({
      strong: [
        { conversationId: "conv_a", isPrimary: true },
        { conversationId: "conv_b", isPrimary: false },
      ],
      weak: [{ conversationId: "conv_a", isPrimary: true }],
    })
  })

  test("moves an earlier message out of another conversation, and never one already in the target", async () => {
    const ctx = context({
      recentMessages: [
        message({ id: "msg_stray", contentMarkdown: "Stray opener" }),
        message({ id: "msg_settled", contentMarkdown: "Settled turn" }),
      ],
      activeConversations: [
        conversation({ contextMessageIds: ["msg_settled"] }),
        conversation({ id: "conv_b", contextMessageIds: ["msg_stray"] }),
      ],
    })
    const { ai, decisionCalls } = createAI(
      { placement: "conv_a", "move::msg_stray": 0.9, "move::msg_settled": 0.99 },
      NO_PROSE
    )

    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(ctx)

    expect({
      reassignments: result.reassignments?.map((r) => ({ messageId: r.messageId, to: r.toConversationId })),
      askedAbout: Object.keys(decisionCalls[0].questions)
        .filter((k) => k.startsWith("move::"))
        .sort(),
    }).toEqual({
      reassignments: [{ messageId: "msg_stray", to: "conv_a" }],
      askedAbout: ["move::msg_settled", "move::msg_stray"],
    })
  })

  test("opens a new conversation and pulls the moved messages into it", async () => {
    const ctx = context({
      recentMessages: [message({ id: "msg_stray", contentMarkdown: "Stray opener" })],
      activeConversations: [conversation({ contextMessageIds: ["msg_stray"] })],
    })
    const { ai, proseCalls } = createAI(
      { placement: "new_conversation", "move::msg_stray": 0.9 },
      { title: "Rollback-plan", summary: "Om rollbacken." }
    )

    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(ctx)

    expect({
      result: {
        assignments: result.assignments,
        newConversationTopic: result.newConversationTopic,
        newConversationSummary: result.newConversationSummary,
        moves: result.reassignments?.map((r) => ({ messageId: r.messageId, to: r.toConversationId })),
        completenessUpdates: result.completenessUpdates,
      },
      proseCalls: proseCalls.length,
    }).toEqual({
      result: {
        assignments: [{ conversationId: null, isPrimary: true }],
        newConversationTopic: "Rollback-plan",
        newConversationSummary: "Om rollbacken.",
        moves: [{ messageId: "msg_stray", to: null }],
        completenessUpdates: [{ conversationId: "conv_a", score: 1, status: "active" }],
      },
      proseCalls: 1,
    })
  })

  test("falls back to the message's own opening when the prose model returns no title", async () => {
    const { ai } = createAI({ placement: "new_conversation" }, NO_PROSE)
    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(
      context({ newMessage: message({ contentMarkdown: "Kan vi rulla tillbaka? Det brinner." }) })
    )

    expect(result.newConversationTopic).toBe("Kan vi rulla tillbaka")
  })

  test("treats a choice that names no listed conversation as a new conversation", async () => {
    const { ai } = createAI({ placement: "conv_gone" }, { title: "Ny tråd", summary: "Om något annat." })
    const result = await new DecisionsBoundaryExtractor(ai, configResolver).extract(context())

    expect(result.assignments).toEqual([{ conversationId: null, isPrimary: true }])
  })

  test("asks about the parent-thread conversation as well as the active ones", async () => {
    const { ai, decisionCalls } = createAI({ placement: "conv_parent" }, NO_PROSE)
    await new DecisionsBoundaryExtractor(ai, configResolver).extract(
      context({ streamType: "thread", parentMessageConversations: [conversation({ id: "conv_parent" })] })
    )

    const placement = decisionCalls[0].questions.placement
    expect(placement.type === "choice" && Object.keys(placement.criteria).sort()).toEqual([
      "conv_a",
      "conv_parent",
      "new_conversation",
    ])
  })
})
