import { parseMarkdown } from "@threa/prosemirror"
import type { EvalContext, EvalSuite } from "../../framework/types"
import { createPolishTranscript, type PolishOutcome } from "../../../src/features/voice-transcription/polish"
import { createDecideVoiceBoundaryScope } from "../../../src/features/voice-transcription/scope"
import { voicePolishConfig } from "../../../src/features/voice-transcription/config"
import { IncrementalVoiceEngine, scalarLength } from "../../../src/features/voice-transcription/incremental-engine"
import { IncrementalPolishCoordinator } from "../../../src/features/voice-transcription/incremental-coordinator"
import { voicePolishCases } from "./cases"
import { metricsEvaluator, voicePolishEvaluators } from "./evaluators"
import type { VoicePolishExpected, VoicePolishInput, VoicePolishOutput } from "./types"

const composedDocument = (
  engine: IncrementalVoiceEngine
): Extract<PolishOutcome, { status: "success" }> | { status: "empty_input" } => {
  const markdown = engine.windows
    .map((window) => engine.visibleMarkdown(window))
    .filter(Boolean)
    .join("\n\n")
  return markdown ? { status: "success", markdown, contentJson: parseMarkdown(markdown) } : { status: "empty_input" }
}

export async function runVoicePolishTask(input: VoicePolishInput, ctx: EvalContext): Promise<VoicePolishOutput> {
  const override = ctx.componentOverrides?.["voice-polish"]
  const config = {
    ...voicePolishConfig,
    model: override?.model ?? ctx.permutation.model,
    temperature: override?.temperature ?? ctx.permutation.temperature ?? voicePolishConfig.temperature,
  }
  const engine = new IncrementalVoiceEngine()
  const steps: VoicePolishOutput["steps"] = []
  const omitPrevious = ctx.permutation.promptVariant === "without-previous" || override?.prompt === "without-previous"
  const takeContext = {
    draftBefore: input.steps[0]?.draftBefore ?? input.draftBefore,
    draftAfter: input.steps[0]?.draftAfter ?? input.draftAfter,
  }

  for (const [index, step] of input.steps.entries()) {
    const attempts: NonNullable<VoicePolishOutput["steps"][number]["attempts"]> = []
    const polish = createPolishTranscript({ ai: ctx.ai, config, onAttempt: (attempt) => attempts.push(attempt) })
    const decideScope = createDecideVoiceBoundaryScope({
      ai: ctx.ai,
      config,
      onAttempt: (attempt) => attempts.push(attempt),
    })
    const coordinator = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: polish,
      decideBoundaryScope: decideScope,
      includePreviousAccepted: !omitPrevious,
      applyOperation: async () => step.ackStatus ?? "applied",
      context: {
        level: input.level ?? "opinionated",
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        sessionId: "voice-polish-eval",
        ...takeContext,
        steeringTerms: input.steeringTerms,
      },
    })
    const deltas = step.stopWithoutNewFinal ? [] : engine.appendFinal(step.rawTranscript)
    const window = deltas.at(-1)?.window ?? (step.stopWithoutNewFinal ? engine.activeWindow : undefined)
    const deadline = step.deadline ?? (index === input.steps.length - 1 ? "final" : "live")
    const predecessorBefore = window ? engine.immediateAcceptedPredecessor(window)?.accepted?.contentJson : undefined
    const started = performance.now()
    const result = window
      ? await coordinator.run(window, deadline, deadline === "final")
      : { status: "empty_input" as const }
    const document = composedDocument(engine)
    let outcome: PolishOutcome
    if (result.status === "applied" || result.status === "reused") outcome = document
    else if (result.status === "invalid_output") outcome = { status: "invalid_output", reason: result.reason }
    else if (result.status === "rejected") outcome = { status: "replacement_rejected" }
    else if (result.status === "preserve_raw") outcome = { status: "preserve_raw" }
    else outcome = { status: result.status }
    const raw = window ? engine.raw(window) : ""
    const rawLower = step.rawTranscript.toLocaleLowerCase()
    const context = [takeContext.draftBefore, takeContext.draftAfter]
      .flatMap((value) => value?.split("\n") ?? [])
      .map((value) => value.replace(/^\s*(?:#+|[-*])\s*/, "").trim())
      .filter((value) => Boolean(value) && !rawLower.includes(value.toLocaleLowerCase()))
    const predecessorAfter = window ? engine.immediateAcceptedPredecessor(window)?.accepted?.contentJson : undefined
    const finalModelCallCount = attempts.filter(
      (attempt) => attempt.deadline === "final" && attempt.stage !== "scope"
    ).length
    steps.push({
      outcome,
      coordinatorResult: result,
      composedDocument: document,
      attempts,
      scope: "scope" in result ? result.scope : undefined,
      durationMs: Math.round(performance.now() - started),
      deadline,
      sourceWindowCount: result.status === "applied" && result.widened ? 2 : 1,
      rawCharCount: scalarLength(raw),
      reasoningEffort: config.reasoningEffort,
      finalCallMade: finalModelCallCount > 0,
      finalModelCallCount,
      reused: result.status === "reused",
      predecessorStable:
        predecessorBefore === undefined || JSON.stringify(predecessorBefore) === JSON.stringify(predecessorAfter),
      forbiddenContextTerms: context,
    })
  }
  const finalStep = steps.at(-1)
  const document = composedDocument(engine)
  const outcome = finalStep?.outcome ?? { status: "empty_input" as const }
  return {
    steps,
    outcome,
    composedDocument: document,
    ...(document.status === "success" ? { markdown: document.markdown, contentJson: document.contentJson } : {}),
    durationMs: steps.reduce((sum, step) => sum + step.durationMs, 0),
  }
}

export const voicePolishSuite: EvalSuite<VoicePolishInput, VoicePolishOutput, VoicePolishExpected> = {
  name: "voice-polish",
  description: "Measures bounded incremental dictation formatting, correction, safety, latency, and timeout rate",
  cases: voicePolishCases,
  task: runVoicePolishTask,
  evaluators: voicePolishEvaluators,
  runEvaluators: [metricsEvaluator],
  defaultPermutations: [{ model: voicePolishConfig.model, temperature: voicePolishConfig.temperature }],
  promptVariants: { "without-previous": "Do not provide a previous accepted polish." },
}
export default voicePolishSuite
