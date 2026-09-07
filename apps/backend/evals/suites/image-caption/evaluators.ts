/**
 * Image Caption Evaluators
 *
 * All deterministic. The question this suite answers is whether the text an
 * image is reduced to still carries what a later reader needs, and that is a
 * string-coverage question — no judge, so a run costs one call per case.
 */

import type { Evaluator, EvaluatorResult, RunEvaluator, CaseResult } from "../../framework/types"
import type { ImageCaptionOutput, ImageCaptionExpected } from "./types"

/** Collapse every run of whitespace, thin and non-breaking spaces included. */
function normalize(text: string): string {
  return text.replace(/[\s\u00a0\u202f]+/g, " ").toLowerCase()
}

function coverage(haystack: string, needles: string[]): { found: string[]; missing: string[] } {
  const hay = normalize(haystack)
  const found: string[] = []
  const missing: string[] = []
  for (const needle of needles) {
    if (hay.includes(normalize(needle))) {
      found.push(needle)
    } else {
      missing.push(needle)
    }
  }
  return { found, missing }
}

function failed(name: string, details: string): EvaluatorResult {
  return { name, score: 0, passed: false, details }
}

export const contentTypeEvaluator: Evaluator<ImageCaptionOutput, ImageCaptionExpected> = {
  name: "content-type",
  evaluate: (output, expected) => {
    if (!output.analysis) return failed("content-type", output.error ?? "No analysis")
    const passed = output.analysis.contentType === expected.contentType
    return {
      name: "content-type",
      score: passed ? 1 : 0,
      passed,
      details: passed ? undefined : `Expected ${expected.contentType}, got ${output.analysis.contentType}`,
    }
  },
}

/**
 * The transcription is the only copy of the image's text that search, memo
 * extraction and agent prompts ever see, so this is the load-bearing score.
 */
export const textCoverageEvaluator: Evaluator<ImageCaptionOutput, ImageCaptionExpected> = {
  name: "text-coverage",
  evaluate: (output, expected) => {
    if (!output.analysis) return failed("text-coverage", output.error ?? "No analysis")
    if (!output.flatText) return failed("text-coverage", "No text transcribed")

    const { found, missing } = coverage(output.flatText, expected.requiredText)
    const score = found.length / expected.requiredText.length
    return {
      name: "text-coverage",
      score,
      passed: missing.length === 0,
      details: missing.length > 0 ? `Missing: ${missing.join(" | ")}` : undefined,
    }
  },
}

/**
 * A reader who never opens the image gets the summary alone, so it has to
 * carry the specifics rather than describe the genre of the picture.
 */
export const summaryDetailEvaluator: Evaluator<ImageCaptionOutput, ImageCaptionExpected> = {
  name: "summary-detail",
  evaluate: (output, expected) => {
    if (!output.analysis) return failed("summary-detail", output.error ?? "No analysis")

    const { found, missing } = coverage(output.analysis.summary, expected.summaryMentions)
    const score = found.length / expected.summaryMentions.length
    return {
      name: "summary-detail",
      score,
      passed: missing.length === 0,
      details: missing.length > 0 ? `Summary omits: ${missing.join(" | ")}` : undefined,
    }
  },
}

export const structuredDataEvaluator: Evaluator<ImageCaptionOutput, ImageCaptionExpected> = {
  name: "structured-data",
  evaluate: (output, expected) => {
    if (!output.analysis) return failed("structured-data", output.error ?? "No analysis")

    const present = output.analysis.structuredData !== null
    const wanted = expected.structuredData === "required"
    const passed = present === wanted
    return {
      name: "structured-data",
      score: passed ? 1 : 0,
      passed,
      details: passed ? undefined : wanted ? "structuredData is null" : "structuredData set on a non-data image",
    }
  },
}

/** Catches translation and invented text, both of which cost a reader trust. */
export const noInventionEvaluator: Evaluator<ImageCaptionOutput, ImageCaptionExpected> = {
  name: "no-invention",
  evaluate: (output, expected) => {
    if (!expected.forbiddenText?.length) {
      return { name: "no-invention", score: 1, passed: true, details: "No forbidden strings" }
    }
    if (!output.analysis) return failed("no-invention", output.error ?? "No analysis")

    const haystack = `${output.analysis.summary}\n${output.flatText ?? ""}`
    const { found } = coverage(haystack, expected.forbiddenText)
    return {
      name: "no-invention",
      score: found.length === 0 ? 1 : 0,
      passed: found.length === 0,
      details: found.length > 0 ? `Present but not in the image: ${found.join(" | ")}` : undefined,
    }
  },
}

/** Mean transcription coverage across the suite: the number to compare models on. */
export const transcriptionCoverageEvaluator: RunEvaluator<ImageCaptionOutput, ImageCaptionExpected> = {
  name: "transcription-coverage",
  evaluate: (results: CaseResult<ImageCaptionOutput, ImageCaptionExpected>[]): EvaluatorResult => {
    const scores = results
      .map((r) => r.evaluations.find((e) => e.name === "text-coverage")?.score)
      .filter((s): s is number => s !== undefined)

    if (scores.length === 0) {
      return { name: "transcription-coverage", score: 0, passed: false, details: "No cases scored" }
    }

    const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length
    return {
      name: "transcription-coverage",
      score: mean,
      passed: mean >= 0.9,
      details: `Mean coverage ${(mean * 100).toFixed(1)}% across ${scores.length} case runs`,
    }
  },
}
