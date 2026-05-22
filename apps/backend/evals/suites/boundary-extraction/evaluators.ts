/**
 * Boundary Extraction Evaluators
 */

import type { Evaluator, EvaluatorResult, RunEvaluator, CaseResult } from "../../framework/types"
import type { BoundaryExtractionOutput, BoundaryExtractionExpected } from "./types"

/**
 * Evaluator that checks if the correct conversation decision was made.
 */
export const conversationDecisionEvaluator: Evaluator<BoundaryExtractionOutput, BoundaryExtractionExpected> = {
  name: "conversation-decision",
  evaluate: (output: BoundaryExtractionOutput, expected: BoundaryExtractionExpected): EvaluatorResult => {
    // Skip if error occurred
    if (output.error) {
      return { name: "conversation-decision", score: 0, passed: false, details: `Error: ${output.error}` }
    }

    // Check if should create new conversation
    if (expected.expectNewConversation !== undefined) {
      const isNew = output.conversationId === null
      if (expected.expectNewConversation !== isNew) {
        return {
          name: "conversation-decision",
          score: 0,
          passed: false,
          details: expected.expectNewConversation
            ? `Expected new conversation but got conversationId: ${output.conversationId}`
            : `Expected existing conversation but got new`,
        }
      }
    }

    // Check if should join specific conversation
    if (expected.expectConversationId !== undefined) {
      if (output.conversationId !== expected.expectConversationId) {
        return {
          name: "conversation-decision",
          score: 0,
          passed: false,
          details: `Expected conversationId: ${expected.expectConversationId}, got: ${output.conversationId}`,
        }
      }
    }

    return { name: "conversation-decision", score: 1, passed: true }
  },
}

/**
 * Evaluator that checks if new conversation topic contains expected words.
 */
export const topicContainsEvaluator: Evaluator<BoundaryExtractionOutput, BoundaryExtractionExpected> = {
  name: "topic-contains",
  evaluate: (output: BoundaryExtractionOutput, expected: BoundaryExtractionExpected): EvaluatorResult => {
    if (!expected.topicContains || expected.topicContains.length === 0) {
      return { name: "topic-contains", score: 1, passed: true, details: "No topic requirements" }
    }

    // Skip if not a new conversation
    if (output.conversationId !== null) {
      return { name: "topic-contains", score: 1, passed: true, details: "Not a new conversation" }
    }

    const topic = (output.newConversationTopic || "").toLowerCase()
    const found = expected.topicContains.filter((word) => topic.includes(word.toLowerCase()))
    const missing = expected.topicContains.filter((word) => !topic.includes(word.toLowerCase()))

    // Pass if at least one expected word is found
    const score = found.length / expected.topicContains.length
    const passed = found.length > 0

    return {
      name: "topic-contains",
      score,
      passed,
      details: passed ? undefined : `Topic "${output.newConversationTopic}" missing: ${missing.join(", ")}`,
    }
  },
}

/**
 * Evaluator that checks the new conversation topic avoids unwanted phrases
 * (framing preamble like "discussion about", language labels like "in swedish").
 */
export const topicNotContainsEvaluator: Evaluator<BoundaryExtractionOutput, BoundaryExtractionExpected> = {
  name: "topic-not-contains",
  evaluate: (output: BoundaryExtractionOutput, expected: BoundaryExtractionExpected): EvaluatorResult => {
    if (!expected.topicNotContains || expected.topicNotContains.length === 0) {
      return { name: "topic-not-contains", score: 1, passed: true, details: "No exclusion requirements" }
    }

    // Skip if not a new conversation
    if (output.conversationId !== null) {
      return { name: "topic-not-contains", score: 1, passed: true, details: "Not a new conversation" }
    }

    const topic = (output.newConversationTopic || "").toLowerCase()
    const found = expected.topicNotContains.filter((word) => topic.includes(word.toLowerCase()))

    const passed = found.length === 0
    return {
      name: "topic-not-contains",
      score: passed ? 1 : 0,
      passed,
      details:
        found.length > 0 ? `Topic "${output.newConversationTopic}" contains unwanted: ${found.join(", ")}` : undefined,
    }
  },
}

/**
 * Evaluator that checks confidence is above threshold.
 */
export const confidenceEvaluator: Evaluator<BoundaryExtractionOutput, BoundaryExtractionExpected> = {
  name: "confidence",
  evaluate: (output: BoundaryExtractionOutput, expected: BoundaryExtractionExpected): EvaluatorResult => {
    const minConfidence = expected.minConfidence ?? 0.5
    const passed = output.confidence >= minConfidence

    return {
      name: "confidence",
      score: output.confidence,
      passed,
      details: passed ? undefined : `Confidence ${output.confidence.toFixed(2)} below threshold ${minConfidence}`,
    }
  },
}

/**
 * Evaluator that checks completeness updates are correct.
 */
export const completenessUpdateEvaluator: Evaluator<BoundaryExtractionOutput, BoundaryExtractionExpected> = {
  name: "completeness-update",
  evaluate: (output: BoundaryExtractionOutput, expected: BoundaryExtractionExpected): EvaluatorResult => {
    if (!expected.expectCompletenessUpdate || expected.expectCompletenessUpdate.length === 0) {
      return { name: "completeness-update", score: 1, passed: true, details: "No completeness requirements" }
    }

    const updates = output.completenessUpdates || []
    const errors: string[] = []

    for (const expectedUpdate of expected.expectCompletenessUpdate) {
      const actual = updates.find((u) => u.conversationId === expectedUpdate.conversationId)

      if (!actual) {
        errors.push(`Missing update for ${expectedUpdate.conversationId}`)
        continue
      }

      if (expectedUpdate.minScore !== undefined && actual.score < expectedUpdate.minScore) {
        errors.push(`Score ${actual.score} below expected min ${expectedUpdate.minScore}`)
      }

      if (expectedUpdate.maxScore !== undefined && actual.score > expectedUpdate.maxScore) {
        errors.push(`Score ${actual.score} above expected max ${expectedUpdate.maxScore}`)
      }

      if (expectedUpdate.status !== undefined && actual.status !== expectedUpdate.status) {
        errors.push(`Status ${actual.status} != expected ${expectedUpdate.status}`)
      }
    }

    const passed = errors.length === 0
    return {
      name: "completeness-update",
      score: passed ? 1 : 0,
      passed,
      details: errors.length > 0 ? errors.join("; ") : undefined,
    }
  },
}

/**
 * Run-level evaluator that checks overall accuracy.
 */
export const accuracyEvaluator: RunEvaluator<BoundaryExtractionOutput, BoundaryExtractionExpected> = {
  name: "accuracy",
  evaluate: (cases: CaseResult<BoundaryExtractionOutput, BoundaryExtractionExpected>[]): EvaluatorResult => {
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
 * Run-level evaluator for conversation decision accuracy.
 */
export const decisionAccuracyEvaluator: RunEvaluator<BoundaryExtractionOutput, BoundaryExtractionExpected> = {
  name: "decision-accuracy",
  evaluate: (cases: CaseResult<BoundaryExtractionOutput, BoundaryExtractionExpected>[]): EvaluatorResult => {
    const decisionResults = cases.map((c) => {
      const decisionEval = c.evaluations.find((e) => e.name === "conversation-decision")
      return decisionEval?.passed ?? false
    })

    const correct = decisionResults.filter((r) => r).length
    const score = cases.length > 0 ? correct / cases.length : 0

    return {
      name: "decision-accuracy",
      score,
      passed: score >= 0.8,
      details: `${correct}/${cases.length} correct decisions`,
    }
  },
}

/**
 * Run-level evaluator for average confidence.
 */
export const averageConfidenceEvaluator: RunEvaluator<BoundaryExtractionOutput, BoundaryExtractionExpected> = {
  name: "average-confidence",
  evaluate: (cases: CaseResult<BoundaryExtractionOutput, BoundaryExtractionExpected>[]): EvaluatorResult => {
    const confidences = cases.filter((c) => !c.error && c.output).map((c) => c.output!.confidence)

    if (confidences.length === 0) {
      return { name: "average-confidence", score: 0, passed: false, details: "No results to evaluate" }
    }

    const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length

    return {
      name: "average-confidence",
      score: avg,
      passed: avg >= 0.6,
      details: `Average confidence: ${avg.toFixed(2)}`,
    }
  },
}
