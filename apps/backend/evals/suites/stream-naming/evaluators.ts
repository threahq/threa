/**
 * Stream Naming Evaluators
 */

import type { Evaluator, EvaluatorResult, RunEvaluator, CaseResult } from "../../framework/types"
import type { StreamNamingOutput, StreamNamingExpected } from "./types"

export const actionEvaluator: Evaluator<StreamNamingOutput, StreamNamingExpected> = {
  name: "action",
  evaluate: (output, expected) => {
    if (!expected.expectedAction) return { name: "action", score: 1, passed: true, details: "No expectation set" }
    const passed = output.action === expected.expectedAction
    return {
      name: "action",
      score: passed ? 1 : 0,
      passed,
      details: passed ? undefined : `Expected ${expected.expectedAction}, got ${output.action}`,
    }
  },
}

/**
 * Evaluator that checks word count is within expected range.
 */
export const wordCountEvaluator: Evaluator<StreamNamingOutput, StreamNamingExpected> = {
  name: "word-count",
  evaluate: (output: StreamNamingOutput, expected: StreamNamingExpected): EvaluatorResult => {
    // Skip if no name was generated
    if (output.action === "defer" || !output.name) {
      return { name: "word-count", score: 1, passed: true, details: "No name generated" }
    }

    const range = expected.wordCountRange ?? { min: 2, max: 5 }
    const wordCount = output.name.split(/\s+/).length

    const passed = wordCount >= range.min && wordCount <= range.max
    return {
      name: "word-count",
      score: passed ? 1 : 0,
      passed,
      details: `Word count: ${wordCount} (expected ${range.min}-${range.max})`,
    }
  },
}

/**
 * Evaluator that checks if name contains expected words/phrases.
 */
export const nameContainsEvaluator: Evaluator<StreamNamingOutput, StreamNamingExpected> = {
  name: "name-contains",
  evaluate: (output: StreamNamingOutput, expected: StreamNamingExpected): EvaluatorResult => {
    if (!expected.nameContains || expected.nameContains.length === 0) {
      return { name: "name-contains", score: 1, passed: true, details: "No contains requirements" }
    }

    // Skip if no name was generated
    if (output.action === "defer" || !output.name) {
      return {
        name: "name-contains",
        score: 0,
        passed: false,
        details: "No name generated but expected contains",
      }
    }

    const nameLower = output.name.toLowerCase()
    const found = expected.nameContains.filter((phrase) => nameLower.includes(phrase.toLowerCase()))
    const missing = expected.nameContains.filter((phrase) => !nameLower.includes(phrase.toLowerCase()))

    // Pass if at least one expected phrase is found (flexible matching)
    const score = found.length / expected.nameContains.length
    const passed = found.length > 0

    return {
      name: "name-contains",
      score,
      passed,
      details: missing.length > 0 ? `Name: "${output.name}", missing any of: ${missing.join(", ")}` : undefined,
    }
  },
}

/**
 * Evaluator that checks if name does NOT contain unwanted phrases.
 */
export const nameNotContainsEvaluator: Evaluator<StreamNamingOutput, StreamNamingExpected> = {
  name: "name-not-contains",
  evaluate: (output: StreamNamingOutput, expected: StreamNamingExpected): EvaluatorResult => {
    if (!expected.nameNotContains || expected.nameNotContains.length === 0) {
      return { name: "name-not-contains", score: 1, passed: true, details: "No exclusion requirements" }
    }

    // Skip if no name was generated
    if (output.action === "defer" || !output.name) {
      return { name: "name-not-contains", score: 1, passed: true, details: "No name generated" }
    }

    const nameLower = output.name.toLowerCase()
    const found = expected.nameNotContains.filter((phrase) => nameLower.includes(phrase.toLowerCase()))

    const passed = found.length === 0
    return {
      name: "name-not-contains",
      score: passed ? 1 : 0,
      passed,
      details: found.length > 0 ? `Unwanted phrases found: ${found.join(", ")}` : undefined,
    }
  },
}

/**
 * Evaluator that checks if generic names are avoided.
 */
export const avoidsGenericEvaluator: Evaluator<StreamNamingOutput, StreamNamingExpected> = {
  name: "avoids-generic",
  evaluate: (output: StreamNamingOutput, expected: StreamNamingExpected): EvaluatorResult => {
    // Skip if allowGeneric is set (for forced minimal-context cases)
    if (expected.allowGeneric) {
      return { name: "avoids-generic", score: 1, passed: true, details: "Generic names allowed for this case" }
    }

    // Skip if no name was generated
    if (output.action === "defer" || !output.name) {
      return { name: "avoids-generic", score: 1, passed: true, details: "No name generated" }
    }

    const genericPhrases = [
      "quick question",
      "new discussion",
      "chat",
      "conversation",
      "discussion",
      "untitled",
      "new chat",
      "help request",
    ]

    const nameLower = output.name.toLowerCase()
    const found = genericPhrases.filter((phrase) => nameLower === phrase || nameLower.includes(phrase))

    const passed = found.length === 0
    return {
      name: "avoids-generic",
      score: passed ? 1 : 0,
      passed,
      details: found.length > 0 ? `Generic phrase found: "${found[0]}"` : undefined,
    }
  },
}

/**
 * Run-level evaluator that checks overall accuracy.
 */
export const accuracyEvaluator: RunEvaluator<StreamNamingOutput, StreamNamingExpected> = {
  name: "accuracy",
  evaluate: (cases: CaseResult<StreamNamingOutput, StreamNamingExpected>[]): EvaluatorResult => {
    const passedCases = cases.filter((c) => !c.error && c.evaluations.every((e) => e.passed))
    const score = cases.length > 0 ? passedCases.length / cases.length : 0

    return {
      name: "accuracy",
      score,
      passed: score >= 0.8,
      details: `${passedCases.length}/${cases.length} cases passed`,
    }
  },
}

/**
 * Run-level evaluator for word count compliance.
 */
export const wordCountComplianceEvaluator: RunEvaluator<StreamNamingOutput, StreamNamingExpected> = {
  name: "word-count-compliance",
  evaluate: (cases: CaseResult<StreamNamingOutput, StreamNamingExpected>[]): EvaluatorResult => {
    const wordCountResults = cases
      .filter((c) => !c.error && c.output && c.output.action !== "defer" && c.output.name)
      .map((c) => {
        const wordCount = c.output!.name!.split(/\s+/).length
        return wordCount >= 2 && wordCount <= 5
      })

    if (wordCountResults.length === 0) {
      return { name: "word-count-compliance", score: 1, passed: true, details: "No names to evaluate" }
    }

    const compliant = wordCountResults.filter((r) => r).length
    const score = compliant / wordCountResults.length

    return {
      name: "word-count-compliance",
      score,
      passed: score >= 0.9,
      details: `${compliant}/${wordCountResults.length} names have 2-5 words`,
    }
  },
}
