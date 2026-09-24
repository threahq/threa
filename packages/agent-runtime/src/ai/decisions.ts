/**
 * Typed decisions — OpenRouter's `/api/alpha/decisions` protocol.
 *
 * A decisions model answers a fixed set of questions about one `state` object
 * and cannot emit prose. The questions are evaluated in parallel and in
 * isolation, so asking more of them costs little beyond the shared input.
 *
 * This is a different wire protocol from chat completions, not a different
 * model on the same one: `/api/v1/chat/completions` rejects these models with a
 * 400 pointing here. That is why it is dispatched by hand instead of through
 * the AI SDK provider.
 */

import { z } from "zod"
import type { UsageWithCost } from "./ai"

export const DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"

/**
 * Whether a model string speaks this protocol rather than chat completions.
 * Sending one down `/api/v1/chat/completions` fails with a 400, so anything
 * that picks a path by model id — the eval runner's `-m`, most of all — has to
 * ask this rather than compare against one pinned id.
 */
export function isDecisionsModel(model: string): boolean {
  return model.includes("typesafe/")
}

/** A yes/no question. */
export interface NoulQuestion {
  type: "noul"
  instructions: string
}

/** A pick-one question. `criteria` maps each option key to what it means. */
export interface ChoiceQuestion {
  type: "choice"
  instructions: string
  criteria: Record<string, string>
}

/**
 * A where-on-this-ladder question. `criteria` is ordered lowest to highest and
 * the returned score indexes into it, landing between levels when the model
 * splits its belief across them.
 */
export interface ScoreQuestion {
  type: "score"
  instructions: string
  criteria: string[]
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
})

const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
})

/**
 * A yes/no belief in [0, 1]. It carries no separate confidence because the
 * value is the belief: 0.5 is maximal uncertainty, not a missing answer.
 */
const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
})

const answerSchema = z.discriminatedUnion("type", [choiceAnswerSchema, scoreAnswerSchema, noulAnswerSchema])

export type ChoiceAnswer = z.infer<typeof choiceAnswerSchema>
export type ScoreAnswer = z.infer<typeof scoreAnswerSchema>
export type NoulAnswer = z.infer<typeof noulAnswerSchema>
export type DecisionAnswer = z.infer<typeof answerSchema>

const decisionsResponseSchema = z.object({
  answers: z.record(z.string(), answerSchema),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .default({}),
})

export interface DecisionsResult {
  answers: Record<string, DecisionAnswer>
  usage: UsageWithCost
}

/**
 * Reads one answer by key and asserts its shape. A question key that never came
 * back, or came back as a different question type than the caller built, is a
 * mismatch between the request and the code reading it — it throws rather than
 * degrade to a default the caller cannot distinguish from a real answer.
 */
export function choiceAnswer(result: DecisionsResult, key: string): ChoiceAnswer {
  return requireAnswer(result, key, "choice") as ChoiceAnswer
}

export function scoreAnswer(result: DecisionsResult, key: string): ScoreAnswer {
  return requireAnswer(result, key, "score") as ScoreAnswer
}

/** The belief itself, in [0, 1]. */
export function noulAnswer(result: DecisionsResult, key: string): number {
  return (requireAnswer(result, key, "noul") as NoulAnswer).noul
}

function requireAnswer(result: DecisionsResult, key: string, type: DecisionAnswer["type"]): DecisionAnswer {
  const answer = result.answers[key]
  if (!answer) {
    throw new Error(`Decision answer "${key}" is missing. Answered: ${Object.keys(result.answers).join(", ")}`)
  }
  if (answer.type !== type) {
    throw new Error(`Decision answer "${key}" is a ${answer.type} question, expected ${type}`)
  }
  return answer
}

/**
 * Rescales a score onto another range. The ladder's own scale is its index
 * range, so a four-level ladder answers in 0..3 whatever the domain's scale is.
 */
export function rescaleScore(answer: ScoreAnswer, max: number): number {
  const levels = Object.keys(answer.legend).length
  if (levels < 2) return 0
  return (answer.score / (levels - 1)) * max
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * A decisions call answers in well under a second, and every caller has an
 * inference path to fall back to. Failing fast is worth more than waiting out a
 * provider that has stopped answering.
 */
export const DECISIONS_TIMEOUT_MS = 20_000

// Statuses that turn away this request's content (a filter upstream of the
// model, an oversized or malformed body) while the endpoint stays up.
const CONTENT_REFUSALS = new Set([400, 403, 413, 422])

export class DecisionsRequestError extends Error {
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`Decisions request failed (${status}): ${body.slice(0, 500)}`)
    this.name = "DecisionsRequestError"
  }

  get refusedContent(): boolean {
    return CONTENT_REFUSALS.has(this.status)
  }
}

/** Dispatches one decisions request. Throws on a non-2xx, a timeout, or an unreadable body. */
export async function requestDecisions(params: {
  apiKey: string
  modelId: string
  state: unknown
  questions: Record<string, DecisionQuestion>
  abortSignal?: AbortSignal
  timeoutMs?: number
}): Promise<DecisionsResult> {
  const timeout = AbortSignal.timeout(params.timeoutMs ?? DECISIONS_TIMEOUT_MS)
  const response = await fetch(DECISIONS_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${params.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: params.modelId, state: params.state, questions: params.questions }),
    signal: params.abortSignal ? AbortSignal.any([params.abortSignal, timeout]) : timeout,
  })

  const raw = await response.text()
  if (!response.ok) {
    throw new DecisionsRequestError(response.status, raw)
  }

  const parsed = decisionsResponseSchema.safeParse(parseJson(raw))
  if (!parsed.success) {
    throw new Error(`Decisions response did not match the expected shape: ${parsed.error.message}`)
  }

  const { input_tokens: promptTokens, output_tokens: completionTokens, cost } = parsed.data.usage
  return {
    answers: parsed.data.answers,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens:
        promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined,
      cost,
    },
  }
}
