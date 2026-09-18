import { describe, test, expect, mock } from "bun:test"
import type { AI, DecisionQuestion, GenerateDecisionsOptions } from "@threahq/agent-runtime"
import { DecisionsMemoClassifier } from "./decisions-classifier"
import type { ClassifiableConversation } from "./classifier"
import type { Memo } from "./repository"

type Answers = Record<string, number | string>

function createAI(answers: Answers, confidence = 0.92) {
  const calls: GenerateDecisionsOptions[] = []
  const generateDecisions = mock(async (options: GenerateDecisionsOptions) => {
    calls.push(options)
    const entries = Object.entries(options.questions as Record<string, DecisionQuestion>).map(([key, question]) => {
      const value = answers[key]
      if (question.type === "noul") {
        return [key, { type: "noul", noul: typeof value === "number" ? value : 0 }] as const
      }
      const choice = typeof value === "string" ? value : Object.keys((question as { criteria: object }).criteria)[0]
      return [key, { type: "choice", choice, probabilities: {}, confidence }] as const
    })
    return { answers: Object.fromEntries(entries), usage: {} }
  })

  return { ai: { generateDecisions } as unknown as AI, calls }
}

const conversation: ClassifiableConversation = {
  id: "conv_test",
  topicSummary: "Rollback of the failed migration",
  participantIds: ["usr_01AAAAAAAA", "usr_01BBBBBBBB"],
}

const MESSAGES = '<message id="msg_1">We rolled back</message>\n<message id="msg_2">Agreed</message>'

function memo(): Memo {
  return {
    id: "memo_existing",
    title: "Rollback decision",
    abstract: "The team rolled the migration back.",
    createdAt: new Date("2026-09-10T08:00:00Z"),
  } as Memo
}

const classify = (ai: AI, existingMemos: Memo[] = []) =>
  new DecisionsMemoClassifier(ai).classifyConversation(conversation, MESSAGES, existingMemos, {
    workspaceId: "wsp_test",
  })

describe("DecisionsMemoClassifier", () => {
  test("a produced decision is knowledge-worthy and carries the model's calibrated confidence", async () => {
    const { ai } = createAI({ worth: "decision", action_items: 0.1 }, 0.94)

    expect(await classify(ai)).toEqual({
      isKnowledgeWorthy: true,
      shouldReviseExisting: false,
      revisionReason: null,
      confidence: 0.94,
      containsActionItems: false,
    })
  })

  test.each([["transient_status"], ["reaction_or_relay"], ["social"], ["unresolved"]])(
    "%s is not knowledge-worthy",
    async (choice) => {
      const { ai } = createAI({ worth: choice })
      const result = await classify(ai)
      expect(result.isKnowledgeWorthy).toBe(false)
    }
  )

  test.each([["decision"], ["procedure"], ["learning"], ["reference"]])("%s is knowledge-worthy", async (choice) => {
    const { ai } = createAI({ worth: choice })
    const result = await classify(ai)
    expect(result.isKnowledgeWorthy).toBe(true)
  })

  test("a to-do belief carries only above the floor", async () => {
    const above = createAI({ worth: "social", action_items: 0.7 })
    const below = createAI({ worth: "social", action_items: 0.5 })

    expect({
      above: (await classify(above.ai)).containsActionItems,
      below: (await classify(below.ai)).containsActionItems,
    }).toEqual({ above: true, below: false })
  })

  test("revision is asked only when memos exist, and only lands above the floor", async () => {
    const none = createAI({ worth: "decision" })
    const weak = createAI({ worth: "decision", revise: 0.6 })
    const strong = createAI({ worth: "decision", revise: 0.8 })

    const results = {
      noMemos: await classify(none.ai),
      weak: await classify(weak.ai, [memo()]),
      strong: await classify(strong.ai, [memo()]),
    }

    expect({
      noMemosAsked: Object.keys(none.calls[0].questions),
      withMemosAsked: Object.keys(strong.calls[0].questions).sort(),
      revise: [results.noMemos, results.weak, results.strong].map((r) => r.shouldReviseExisting),
    }).toEqual({
      noMemosAsked: ["worth", "action_items"],
      withMemosAsked: ["action_items", "revise", "worth"],
      revise: [false, false, true],
    })
  })

  test("the state carries the conversation, its messages and the existing memos", async () => {
    const { ai, calls } = createAI({ worth: "decision" })
    await classify(ai, [memo()])

    expect(calls[0].state).toEqual({
      topic: "Rollback of the failed migration",
      participants: ["AAAAAAAA", "BBBBBBBB"],
      messageCount: 2,
      messages: MESSAGES,
      existingMemos: [
        {
          title: "Rollback decision",
          abstract: "The team rolled the migration back.",
          created: "2026-09-10",
        },
      ],
    })
  })
})
