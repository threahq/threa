/**
 * Persona-Style Evaluators
 *
 * Per-case: the reply exists (`should-respond`), lands in its brevity band, and
 * — for tone cases — an LLM judge confirms it exhibits the seeded tone. Run-level:
 * the three brevity replies come out ordered brief < balanced < thorough (the
 * paired same-input comparison), and an accuracy roll-up across all cases.
 */

import type { Evaluator, EvalContext, EvaluatorResult, RunEvaluator, CaseResult } from "../../framework/types"
import { llmJudgeEvaluator } from "../../framework/evaluators/llm-judge"
import type { TonePreset } from "@threa/types"
import type { PersonaStyleOutput, PersonaStyleExpected } from "./types"
import { PERSONA_STYLE_JUDGE_MODEL, STYLE_ACCURACY_GATE } from "./config"

// The judge sees the case's expected descriptor as "Expected Output" and the
// runner's raw record as "Actual Output"; without this it docks points for the
// two JSON shapes differing, which is noise, not a tone signal.
const JUDGE_SHAPE_CONTEXT = `The "Expected Output" block is a grading spec, NOT a literal JSON shape the output must match. The "Actual Output" block is the eval runner's record; the assistant's reply is its "reply" field. Judge ONLY the reply's DOMINANT tonal register, not helpfulness, correctness, or length. Grade relatively: a reply passes if the required register is clearly the one that predominates, even if a stray phrase of another register appears. Never penalize structural or field-name differences between the two JSON objects.`

const TONE_CRITERIA: Record<TonePreset, string> = {
  warm: "predominantly warm and encouraging — it acknowledges the person's situation or effort and lets genuine care come through in the wording, rather than reading as clinical or blunt",
  neutral:
    "predominantly even and matter-of-fact — plain and courteous, letting the substance carry it, rather than leaning into either effusive warmth or blunt edge",
  direct:
    "predominantly blunt and plainspoken — it leads with a clear assessment, gets to the point with minimal hedging or cushioning, and does not dwell on reassurance or emotional validation. A brief acknowledgment is fine; what matters is that softening and qualifiers do not dominate and the point is not buried",
}

// =============================================================================
// Case-level
// =============================================================================

export const shouldRespondEvaluator: Evaluator<PersonaStyleOutput, PersonaStyleExpected> = {
  name: "should-respond",
  evaluate: (output, expected): EvaluatorResult => {
    if (!expected.shouldRespond) {
      return { name: "should-respond", score: 1, passed: true }
    }
    const responded = output.responded && output.reply.trim().length > 0
    return {
      name: "should-respond",
      score: responded ? 1 : 0,
      passed: responded,
      details: responded ? undefined : (output.error ?? "Agent produced no reply to grade style on"),
    }
  },
}

export const brevityBandEvaluator: Evaluator<PersonaStyleOutput, PersonaStyleExpected> = {
  name: "brevity-band",
  evaluate: (output, expected): EvaluatorResult => {
    const band = expected.brevityBand
    if (!band) {
      return { name: "brevity-band", score: 1, passed: true, details: "No band requirement" }
    }
    const { wordCount } = output
    const overMax = band.maxWords !== undefined && wordCount > band.maxWords
    const underMin = band.minWords !== undefined && wordCount < band.minWords
    const passed = !overMax && !underMin
    const bandStr = [
      band.minWords !== undefined ? `>= ${band.minWords}` : null,
      band.maxWords !== undefined ? `<= ${band.maxWords}` : null,
    ]
      .filter(Boolean)
      .join(" and ")
    return {
      name: "brevity-band",
      score: passed ? 1 : 0,
      passed,
      details: passed ? undefined : `Reply has ${wordCount} words (expected ${bandStr})`,
    }
  },
}

/**
 * LLM-as-judge tone adherence, following the companion suite's createToneEvaluator
 * pattern but with criteria for the warm/neutral/direct presets this suite drives.
 */
export function createToneAdherenceEvaluator(): Evaluator<PersonaStyleOutput, PersonaStyleExpected> {
  return {
    name: "tone-adherence",
    evaluate: async (output, expected, ctx: EvalContext): Promise<EvaluatorResult> => {
      const tone = expected.tone
      if (!tone) {
        return { name: "tone-adherence", score: 1, passed: true, details: "No tone requirement" }
      }
      if (!output.reply.trim()) {
        return { name: "tone-adherence", score: 0, passed: false, details: "No reply to judge" }
      }
      const judge = llmJudgeEvaluator<PersonaStyleOutput, PersonaStyleExpected>({
        name: "tone-adherence",
        model: PERSONA_STYLE_JUDGE_MODEL,
        passThreshold: 0.7,
        criteria: `The reply's tone should be ${tone}: ${TONE_CRITERIA[tone]}.
Score high when ${tone} is clearly the reply's dominant register among warm / neutral / direct.`,
        context: JUDGE_SHAPE_CONTEXT,
      })
      return judge.evaluate(output, expected, ctx)
    },
  }
}

// =============================================================================
// Run-level
// =============================================================================

function wordCountFor(results: CaseResult<PersonaStyleOutput, PersonaStyleExpected>[], caseId: string): number | null {
  // Exclude task-internal failures too: runPersonaStyleTask catches and returns
  // { error, wordCount: 0 } without throwing, so CaseResult.error alone would
  // let an errored case feed wordCount 0 into the ordering as a fake "brief".
  const found = results.filter((r) => r.caseId === caseId && !r.error && !r.output.error)
  if (found.length === 0) return null
  // Average across repeat runs so -r N stays meaningful.
  const total = found.reduce((sum, r) => sum + r.output.wordCount, 0)
  return total / found.length
}

/**
 * Paired same-input comparison: the brief / balanced / thorough replies to the
 * identical prompt must come out ordered by length. brief < thorough is the
 * hard signal; balanced is required to sit between (ties tolerated) since a
 * mid-length band is fuzzier than the two extremes.
 */
export const brevityOrderingEvaluator: RunEvaluator<PersonaStyleOutput, PersonaStyleExpected> = {
  name: "brevity-ordering",
  evaluate: (results) => {
    const brief = wordCountFor(results, "brevity-brief-001")
    const balanced = wordCountFor(results, "brevity-balanced-001")
    const thorough = wordCountFor(results, "brevity-thorough-001")
    if (brief === null || balanced === null || thorough === null) {
      return {
        name: "brevity-ordering",
        score: 0,
        passed: false,
        details: "Missing one of the brevity cases (brief/balanced/thorough)",
      }
    }
    const ordered = brief <= balanced && balanced <= thorough && brief < thorough
    return {
      name: "brevity-ordering",
      score: ordered ? 1 : 0,
      passed: ordered,
      details: `words — brief=${brief.toFixed(0)}, balanced=${balanced.toFixed(0)}, thorough=${thorough.toFixed(0)}${
        ordered ? "" : " (expected brief <= balanced <= thorough, brief < thorough)"
      }`,
    }
  },
}

export const styleAccuracyEvaluator: RunEvaluator<PersonaStyleOutput, PersonaStyleExpected> = {
  name: "style-accuracy",
  evaluate: (results) => {
    const valid = results.filter((r) => !r.error)
    if (valid.length === 0) {
      return { name: "style-accuracy", score: 0, passed: false, details: "No valid results" }
    }
    const allPassed = valid.filter((r) => r.evaluations.every((e) => e.passed)).length
    const accuracy = allPassed / valid.length
    return {
      name: "style-accuracy",
      score: accuracy,
      passed: accuracy >= STYLE_ACCURACY_GATE,
      details: `${allPassed}/${valid.length} cases passed every evaluator (${(accuracy * 100).toFixed(1)}%)`,
    }
  },
}
