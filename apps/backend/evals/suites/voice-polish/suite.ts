import type { EvalContext, EvalSuite } from "../../framework/types"
import { createPolishTranscript } from "../../../src/features/voice-transcription/polish"
import { voicePolishConfig } from "../../../src/features/voice-transcription/config"
import { voicePolishCases } from "./cases"
import { metricsEvaluator, voicePolishEvaluators } from "./evaluators"
import type { VoicePolishExpected, VoicePolishInput, VoicePolishOutput } from "./types"

export async function runVoicePolishTask(input: VoicePolishInput, ctx: EvalContext): Promise<VoicePolishOutput> {
  const override = ctx.componentOverrides?.["voice-polish"]
  const config = {
    ...voicePolishConfig,
    model: override?.model ?? ctx.permutation.model,
    temperature: override?.temperature ?? ctx.permutation.temperature ?? voicePolishConfig.temperature,
  }
  const polish = createPolishTranscript({ ai: ctx.ai, config })
  const steps: VoicePolishOutput["steps"] = []
  let previousAcceptedMarkdown: string | undefined

  for (const [index, step] of input.steps.entries()) {
    const previous = previousAcceptedMarkdown
    const started = performance.now()
    const outcome = await polish({
      rawTranscript: step.rawTranscript,
      level: input.level ?? "opinionated",
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      sessionId: `voice-polish-eval-${index}`,
      draftBefore: step.draftBefore ?? input.draftBefore,
      draftAfter: step.draftAfter ?? input.draftAfter,
      steeringTerms: input.steeringTerms,
      previousAcceptedMarkdown:
        override?.prompt === "without-previous" || ctx.permutation.promptVariant === "without-previous"
          ? undefined
          : previous,
      deadline: step.deadline ?? (index === input.steps.length - 1 ? "final" : "live"),
    })
    const deadline = step.deadline ?? (index === input.steps.length - 1 ? "final" : "live")
    const rawLower = step.rawTranscript.toLocaleLowerCase()
    const context = [step.draftBefore ?? input.draftBefore, step.draftAfter ?? input.draftAfter]
      .flatMap((value) => value?.split("\n") ?? [])
      .map((value) => value.replace(/^\s*(?:#+|[-*])\s*/, "").trim())
      .filter((value) => Boolean(value) && !rawLower.includes(value.toLocaleLowerCase()))
    steps.push({
      outcome,
      durationMs: Math.round(performance.now() - started),
      deadline,
      previousAcceptedMarkdown: previous,
      forbiddenContextTerms: context,
    })
    if (outcome.status === "success") previousAcceptedMarkdown = outcome.markdown
  }

  const outcome = steps.at(-1)?.outcome ?? { status: "empty_input" as const }
  return {
    steps,
    outcome,
    ...(outcome.status === "success" ? { markdown: outcome.markdown, contentJson: outcome.contentJson } : {}),
    durationMs: steps.reduce((sum, step) => sum + step.durationMs, 0),
  }
}

export const voicePolishSuite: EvalSuite<VoicePolishInput, VoicePolishOutput, VoicePolishExpected> = {
  name: "voice-polish",
  description: "Measures cumulative dictation correction, structure stability, safety, latency, and timeout rate",
  cases: voicePolishCases,
  task: runVoicePolishTask,
  evaluators: voicePolishEvaluators,
  runEvaluators: [metricsEvaluator],
  defaultPermutations: [{ model: voicePolishConfig.model, temperature: voicePolishConfig.temperature }],
  promptVariants: { "without-previous": "Do not provide a previous accepted polish." },
}

export default voicePolishSuite
