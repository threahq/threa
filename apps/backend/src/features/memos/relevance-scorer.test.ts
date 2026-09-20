import { describe, test, expect, mock } from "bun:test"
import type { AI, GenerateDecisionsOptions, ScoreQuestion } from "@threahq/agent-runtime"
import { DecisionsRelevanceScorer } from "./relevance-scorer"
import { RELEVANCE_SCORE_LADDER, RELEVANCE_SCORER_MODEL_ID } from "./config"

const CONTEXT = { workspaceId: "ws_1", userId: "usr_1" }

function aiScoring(rungByKey: Record<string, number>) {
  const calls: GenerateDecisionsOptions[] = []
  const generateDecisions = mock(async (options: GenerateDecisionsOptions) => {
    calls.push(options)
    const legend = Object.fromEntries(RELEVANCE_SCORE_LADDER.map((rung, index) => [String(index), rung]))
    return {
      answers: Object.fromEntries(
        Object.keys(options.questions).map((key) => [
          key,
          { type: "score" as const, score: rungByKey[key] ?? 0, legend, probabilities: {}, confidence: 0.9 },
        ])
      ),
      usage: {},
    }
  })
  return { ai: { generateDecisions } as unknown as AI, calls }
}

const candidates = [{ abstract: "first" }, { abstract: "second" }, { abstract: "third" }]

const scorer = (ai: AI) => new DecisionsRelevanceScorer({ ai, subject: "chat messages", functionId: "search-score" })

describe("DecisionsRelevanceScorer", () => {
  test("asks one ladder question per candidate against one shared state", async () => {
    const { ai, calls } = aiScoring({})
    await scorer(ai).score("deploy rollback", candidates, CONTEXT)

    const call = calls[0]!
    expect(Object.keys(call.questions)).toEqual(["c0", "c1", "c2"])
    expect(call.questions.c1 as ScoreQuestion).toEqual({
      type: "score",
      instructions: "How well does candidate [1] in the candidates list answer the search query?",
      criteria: [...RELEVANCE_SCORE_LADDER],
    })
    expect(call.model).toBe(RELEVANCE_SCORER_MODEL_ID)
    expect(call.state).toEqual({
      subject: "chat messages",
      query: "deploy rollback",
      candidates: [
        { index: 0, text: "first" },
        { index: 1, text: "second" },
        { index: 2, text: "third" },
      ],
    })
  })

  test("returns each candidate's rung rescaled onto [0, 1], in input order", async () => {
    const { ai } = aiScoring({ c0: 0, c1: 3, c2: 1.5 })
    expect(await scorer(ai).score("q", candidates, CONTEXT)).toEqual([0, 1, 0.5])
  })

  test("returns null rather than zeros when the call fails, so a caller that cuts on scores keeps its list", async () => {
    const ai = {
      generateDecisions: mock(async () => {
        throw new Error("decisions endpoint down")
      }),
    } as unknown as AI
    expect(await scorer(ai).score("q", candidates, CONTEXT)).toBeNull()
  })

  test("returns null when an answer comes back as the wrong question type", async () => {
    const ai = {
      generateDecisions: mock(async () => ({ answers: { c0: { type: "noul" as const, noul: 1 } }, usage: {} })),
    } as unknown as AI
    expect(await scorer(ai).score("q", [{ abstract: "only" }], CONTEXT)).toBeNull()
  })

  test("scores an empty candidate list without calling the model", async () => {
    const { ai, calls } = aiScoring({})
    expect(await scorer(ai).score("q", [], CONTEXT)).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
