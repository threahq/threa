import { describe, test, expect, mock } from "bun:test"
import { AISpendDeniedError, DecisionsAvailability, type AI, type WebPage } from "@threahq/agent-runtime"
import { WebSearchJudge } from "./web-search-judge"

const CONTEXT = { workspaceId: "wsp_test", userId: "usr_test" }

const PAGES: WebPage[] = [
  { title: "Listing", url: "https://a.example", content: "snippet", seen: "listed" },
  { title: "Founding Engineer - Galdera Labs", url: "https://b.example", content: "Staff Engineer", seen: "both" },
  { title: "Guide", url: "https://c.example", content: "guide", seen: "stored" },
]

function createJudge(options: {
  pinned?: boolean
  answers?: Record<string, number>
  throws?: Error
  availability?: DecisionsAvailability
}) {
  const generateDecisions = mock(async (opts: { questions: Record<string, unknown> }) => {
    if (options.throws) throw options.throws
    const answers = Object.fromEntries(
      Object.keys(opts.questions).map((key) => [key, { type: "noul" as const, noul: options.answers?.[key] ?? 0 }])
    )
    return { answers, usage: {} }
  })
  const availability = options.availability ?? new DecisionsAvailability()
  const judge = new WebSearchJudge({
    ai: { generateDecisions } as unknown as AI,
    residency: { isPinned: mock(async () => options.pinned ?? false) },
    availability,
  })
  return { judge, generateDecisions, availability }
}

describe("WebSearchJudge", () => {
  test("asks about staleness only for pages with stored text, and flags the contradicted one", async () => {
    const { judge, generateDecisions } = createJudge({ answers: { onTopic: 0.9, stale1: 0.8, stale2: 0.1 } })

    const verdict = await judge.judge("kris role", PAGES, CONTEXT)

    expect({
      verdict,
      questions: Object.keys(generateDecisions.mock.calls[0]![0].questions).sort(),
    }).toEqual({
      verdict: { offTopic: false, ambiguous: false, stale: [false, true, false] },
      questions: ["distinct", "onTopic", "stale1", "stale2"],
    })
  })

  test("results below the floor are off topic", async () => {
    const { judge } = createJudge({ answers: { onTopic: 0.3, distinct: 0.9 } })
    expect(await judge.judge("q", PAGES, CONTEXT)).toMatchObject({ offTopic: true })
  })

  test("namesakes are ambiguous only between the floor and sure", async () => {
    const { judge: unsure } = createJudge({ answers: { onTopic: 0.6, distinct: 0.8 } })
    const { judge: sure } = createJudge({ answers: { onTopic: 0.9, distinct: 0.8 } })
    expect([
      (await unsure.judge("threa", PAGES, CONTEXT))?.ambiguous,
      (await sure.judge("threa", PAGES, CONTEXT))?.ambiguous,
    ]).toEqual([true, false])
  })

  test("a pinned workspace is left unjudged and never reaches the decision model", async () => {
    const { judge, generateDecisions } = createJudge({ pinned: true })
    expect(await judge.judge("q", PAGES, CONTEXT)).toBeNull()
    expect(generateDecisions).not.toHaveBeenCalled()
  })

  test("a decision-model failure leaves the results unjudged and trips the breaker", async () => {
    const { judge, availability } = createJudge({ throws: new Error("endpoint down") })
    expect(await judge.judge("q", PAGES, CONTEXT)).toBeNull()
    expect(availability.isAvailable).toBe(false)
  })

  test("a timeout leaves the results unjudged without tripping the breaker", async () => {
    const { judge, availability } = createJudge({ throws: new DOMException("slow", "TimeoutError") })
    expect(await judge.judge("q", PAGES, CONTEXT)).toBeNull()
    expect(availability.isAvailable).toBe(true)
  })

  test("a spend denial is rethrown", async () => {
    const denial = new AISpendDeniedError(
      { workspaceId: "wsp_test", functionId: "web-search-judge" },
      "workspace_limit"
    )
    const { judge } = createJudge({ throws: denial })
    await expect(judge.judge("q", PAGES, CONTEXT)).rejects.toThrow(AISpendDeniedError)
  })
})
