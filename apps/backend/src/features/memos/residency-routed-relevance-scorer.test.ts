import { describe, test, expect, mock } from "bun:test"
import { AISpendDeniedError, DecisionsAvailability, type AI } from "@threahq/agent-runtime"
import { DecisionsRelevanceScorer } from "./relevance-scorer"
import { ResidencyRoutedRelevanceScorer } from "./residency-routed-relevance-scorer"

const SCORES = [1, 0.5, 0]

function createScorer(options: { pinned: boolean; throws?: Error; availability?: DecisionsAvailability }) {
  const decisions = mock(async () => {
    if (options.throws) throw options.throws
    return SCORES
  })
  const availability = options.availability ?? new DecisionsAvailability()
  const scorer = new ResidencyRoutedRelevanceScorer({
    residency: { isPinned: mock(async () => options.pinned) },
    decisions: { score: decisions },
    availability,
  })

  const score = () => scorer.score("q", [{ abstract: "a" }], { workspaceId: "wsp_test" })
  return { score, decisions, availability }
}

describe("ResidencyRoutedRelevanceScorer", () => {
  test("an unpinned workspace is scored by the decision model", async () => {
    const { score, decisions } = createScorer({ pinned: false })
    expect(await score()).toEqual(SCORES)
    expect(decisions).toHaveBeenCalledTimes(1)
  })

  test("a pinned workspace is left unscored and never reaches the decision model", async () => {
    const { score, decisions } = createScorer({ pinned: true })
    expect(await score()).toBeNull()
    expect(decisions).not.toHaveBeenCalled()
  })

  test("a decision-model failure leaves the list unscored and trips the breaker", async () => {
    const availability = new DecisionsAvailability()
    const { score } = createScorer({ pinned: false, throws: new Error("endpoint down"), availability })
    expect(await score()).toBeNull()
    expect(availability.isAvailable).toBe(false)
  })

  test("a tripped breaker skips the call", async () => {
    const availability = new DecisionsAvailability()
    const { score, decisions } = createScorer({ pinned: false, throws: new Error("down"), availability })
    await score()
    decisions.mockClear()

    const next = createScorer({ pinned: false, availability })
    expect(await next.score()).toBeNull()
    expect(next.decisions).not.toHaveBeenCalled()
  })

  test("the real decision scorer, composed as production wires it, trips the breaker on a failure", async () => {
    const availability = new DecisionsAvailability()
    const ai = {
      generateDecisions: mock(async () => {
        throw new Error("decisions endpoint down")
      }),
    } as unknown as AI
    const scorer = new ResidencyRoutedRelevanceScorer({
      residency: { isPinned: mock(async () => false) },
      decisions: new DecisionsRelevanceScorer({ ai, subject: "chat messages", functionId: "search-score" }),
      availability,
    })

    expect(await scorer.score("q", [{ abstract: "a" }], { workspaceId: "wsp_test" })).toBeNull()
    expect(availability.isAvailable).toBe(false)
  })

  test("a spend denial is rethrown, since an unscored retry would not spend less", async () => {
    const denial = new AISpendDeniedError({ workspaceId: "wsp_test", functionId: "search-score" }, "workspace_limit")
    const { score, availability } = createScorer({ pinned: false, throws: denial })
    await expect(score()).rejects.toThrow(AISpendDeniedError)
    expect(availability.isAvailable).toBe(true)
  })
})
