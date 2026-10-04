import { describe, expect, it } from "bun:test"
import { loadGuideArticles } from "@threahq/user-guide"
import { guideUsageEvaluator } from "./evaluators"
import type { CompanionExpected, CompanionOutput, CompanionTrajectoryStep } from "./types"

const KNOWN_SLUG = loadGuideArticles()[0]!.slug

const wantsGuide: CompanionExpected = {
  shouldRespond: true,
  responseCharacteristics: { shouldReadGuide: true },
  reason: "test",
}

function output(trajectory: CompanionTrajectoryStep[]): CompanionOutput {
  return {
    input: { message: "How do I turn on notifications?", streamType: "scratchpad", trigger: "companion" },
    messages: [],
    responded: true,
    trajectory,
  }
}

function call(content: string, completed = true): CompanionTrajectoryStep {
  return { stepType: "tool_call", completed, sourceUrls: [], sourceMemoIds: [], sourceStreamIds: [], content }
}

const guideCall = (article: string, completed = true) =>
  call(JSON.stringify({ tool: "threa_guide", article }), completed)

const evaluate = (out: CompanionOutput, expected = wantsGuide) =>
  guideUsageEvaluator.evaluate(out, expected, {} as never)

describe("guideUsageEvaluator", () => {
  it("should pass when the case has no guide requirement", () => {
    expect(evaluate(output([]), { shouldRespond: true, reason: "test" })).toEqual({
      name: "guide-usage",
      score: 1,
      passed: true,
      details: "No guide requirement",
    })
  })

  it("should pass when a completed threa_guide call reads an existing article", () => {
    expect(evaluate(output([guideCall(KNOWN_SLUG)]))).toEqual({
      name: "guide-usage",
      score: 1,
      passed: true,
      details: undefined,
    })
  })

  const failed = {
    name: "guide-usage",
    score: 0,
    passed: false,
    details: "Expected a completed threa_guide call for an existing article",
  }

  it("should fail when the threa_guide call did not complete", () => {
    expect(evaluate(output([guideCall(KNOWN_SLUG, false)]))).toEqual(failed)
  })

  it("should fail when the call names an article that does not exist", () => {
    expect(evaluate(output([guideCall("made-up-article")]))).toEqual(failed)
  })

  it("should fail when only another tool ran", () => {
    expect(evaluate(output([call(JSON.stringify({ tool: "web_search", article: KNOWN_SLUG }))]))).toEqual(failed)
  })

  it("should fail when the step content is not JSON", () => {
    expect(evaluate(output([call("threa_guide meet-ariadne")]))).toEqual(failed)
  })
})
