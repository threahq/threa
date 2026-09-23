/**
 * Tool Guardian Evaluation Suite
 *
 * Tests the review every tier-2 tool call passes before it runs: did the
 * authorizing user ask for this call? Runs the production ToolGuardianService
 * (INV-45) with production config (INV-44).
 *
 * ## Usage
 *
 *   bun run eval -- -s tool-guardian
 *   bun run eval -- -s tool-guardian -c run-page-injected --runs 3
 *
 * ## Permutations
 *
 * - decision model: the path every unpinned workspace runs. The decision
 *   model may allow on its own; anything else falls to the inference review.
 * - inference model: the residency-pinned path, inference review only.
 *
 * ## Key Evaluators
 *
 * - verdict: allowed matches the expectation; details carry the path, the
 *   decision model's belief and the latency, which is what tunes the floor
 * - false-allow-rate (run-level): must be 0
 */

import type { ModelMessage } from "ai"
import { DecisionsAvailability, isDecisionsModel, noulAnswer, type AI } from "@threahq/agent-runtime"
import type { EvalContext, EvalSuite } from "../../framework/types"
import {
  ToolGuardianService,
  TOOL_GUARDIAN_DECISIONS_MODEL_ID,
  TOOL_GUARDIAN_MODEL_ID,
  TOOL_GUARDIAN_TEMPERATURE,
} from "../../../src/features/agents"
import { createStaticConfigResolver } from "../../../src/lib/ai/static-config-resolver"
import { GUARDIAN_EVAL_PRINCIPAL, toolGuardianCases } from "./cases"
import { accuracyEvaluator, falseAllowRateEvaluator, fastPathRateEvaluator, verdictEvaluator } from "./evaluators"
import type { GuardianEvalMessage, ToolGuardianExpected, ToolGuardianInput, ToolGuardianOutput } from "./types"

function toModelMessage(message: GuardianEvalMessage, index: number): ModelMessage {
  if (message.role === "user") {
    return { role: "user", content: `[msg:msg_eval_${index} author:${message.authorId}] ${message.content}` }
  }
  if (message.role === "assistant") return { role: "assistant", content: message.content }
  return { role: "tool", content: [{ type: "text", text: message.content }] } as never
}

/** Records which reviews ran and the decision model's belief, as production returns them. */
function observing(ai: AI) {
  const seen: { belief?: number; inference: boolean } = { inference: false }
  const observed = Object.create(ai) as AI
  observed.generateDecisions = async (options) => {
    const result = await ai.generateDecisions(options)
    seen.belief = noulAnswer(result, "authorized")
    return result
  }
  observed.generateObject = ((options: Parameters<AI["generateObject"]>[0]) => {
    seen.inference = true
    return ai.generateObject(options)
  }) as AI["generateObject"]
  return { ai: observed, seen }
}

async function runGuardianTask(input: ToolGuardianInput, ctx: EvalContext): Promise<ToolGuardianOutput> {
  const routed = isDecisionsModel(ctx.permutation.model)
  const { ai, seen } = observing(ctx.ai)
  const guardian = new ToolGuardianService(
    {
      ai,
      // With `-m`, ctx.configResolver points every component at the permutation's
      // model; the routed path's inference fallback must stay on its own config.
      configResolver: routed ? createStaticConfigResolver() : ctx.configResolver,
      residency: { isPinned: async () => !routed },
      availability: new DecisionsAvailability(),
    },
    {
      workspaceId: ctx.workspaceId,
      streamId: "stream_eval_guardian",
      personaId: "persona_eval_guardian",
      sessionId: "session_eval_guardian",
      invokingUserId: GUARDIAN_EVAL_PRINCIPAL,
    }
  )

  const started = performance.now()
  try {
    const verdict = await guardian.review({
      toolName: input.toolName,
      toolDescription: input.toolDescription,
      input: input.arguments,
      messages: input.messages.map(toModelMessage),
    })
    return {
      input,
      allowed: verdict.allowed,
      path: seen.inference ? "inference" : "decisions",
      belief: seen.belief,
      reason: verdict.reason,
      latencyMs: Math.round(performance.now() - started),
    }
  } catch (error) {
    return {
      input,
      allowed: false,
      path: "inference",
      belief: seen.belief,
      reason: "",
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const toolGuardianSuite: EvalSuite<ToolGuardianInput, ToolGuardianOutput, ToolGuardianExpected> = {
  name: "tool-guardian",
  description: "Tests the review that decides whether a guarded tool call may run",

  cases: toolGuardianCases,

  task: runGuardianTask,

  evaluators: [verdictEvaluator],

  runEvaluators: [accuracyEvaluator, falseAllowRateEvaluator, fastPathRateEvaluator],

  defaultPermutations: [
    { model: TOOL_GUARDIAN_DECISIONS_MODEL_ID },
    { model: TOOL_GUARDIAN_MODEL_ID, temperature: TOOL_GUARDIAN_TEMPERATURE },
  ],
}

export default toolGuardianSuite
