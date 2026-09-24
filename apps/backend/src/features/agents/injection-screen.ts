import {
  AISpendDeniedError,
  isAbortError,
  noulAnswer,
  type AI,
  type DecisionsAvailability,
  type ToolOutputScreen,
} from "@threahq/agent-runtime"
import type { AIResidencyPolicy } from "../ai-usage"
import { logger } from "../../lib/logger"
import {
  INJECTION_SCREEN_CHUNK_CHARS,
  INJECTION_SCREEN_MODEL_ID,
  INJECTION_SCREEN_QUESTION,
  INJECTION_SCREEN_SUSPECT_AT,
  INJECTION_SCREEN_TIMEOUT_MS,
} from "./config"

interface InjectionScreenContext {
  workspaceId: string
  userId?: string
  sessionId?: string
}

/**
 * Asks the decision model whether web tool output carries text aimed at the
 * agent, in any language. A workspace that pinned its AI residency is not
 * screened: the output goes to the model marked untrusted, without a verdict.
 */
export class InjectionScreen {
  private readonly ai: AI
  private readonly residency: AIResidencyPolicy
  private readonly availability: DecisionsAvailability

  constructor(deps: { ai: AI; residency: AIResidencyPolicy; availability: DecisionsAvailability }) {
    this.ai = deps.ai
    this.residency = deps.residency
    this.availability = deps.availability
  }

  forTurn(context: InjectionScreenContext): ToolOutputScreen {
    return (text, signal) => this.isSuspect(text, context, signal)
  }

  async isSuspect(text: string, context: InjectionScreenContext, signal?: AbortSignal): Promise<boolean | null> {
    if (await this.residency.isPinned(context.workspaceId)) {
      logger.debug({ workspaceId: context.workspaceId }, "Injection screen skipped: workspace AI residency is pinned")
      return null
    }
    if (!this.availability.isAvailable) {
      logger.info({ workspaceId: context.workspaceId }, "Injection screen skipped: decisions endpoint is backing off")
      return null
    }

    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(new DOMException("injection screen timeout", "TimeoutError")),
      INJECTION_SCREEN_TIMEOUT_MS
    )
    const abortSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal

    try {
      const scores = await Promise.all(
        slices(text).map(async (slice) => {
          const result = await this.ai.generateDecisions({
            model: INJECTION_SCREEN_MODEL_ID,
            state: { text: slice },
            questions: { suspect: { type: "noul", instructions: INJECTION_SCREEN_QUESTION } },
            abortSignal,
            telemetry: { functionId: "tool-injection-screen", metadata: { chars: slice.length } },
            context: { ...context, origin: "user" },
          })
          return noulAnswer(result, "suspect")
        })
      )
      return scores.some((score) => score >= INJECTION_SCREEN_SUSPECT_AT)
    } catch (error) {
      if (error instanceof AISpendDeniedError) throw error
      if (isAbortError(error)) {
        if (signal?.aborted) return null
        logger.warn(
          { workspaceId: context.workspaceId, timeoutMs: INJECTION_SCREEN_TIMEOUT_MS },
          "Injection screen timed out; tool output left unjudged"
        )
        return null
      }
      this.availability.recordFailure(error)
      logger.warn({ error, workspaceId: context.workspaceId }, "Injection screen failed; tool output left unjudged")
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

function slices(text: string): string[] {
  const out: string[] = []
  for (let start = 0; start < text.length; start += INJECTION_SCREEN_CHUNK_CHARS) {
    out.push(text.slice(start, start + INJECTION_SCREEN_CHUNK_CHARS))
  }
  return out
}
