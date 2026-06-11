import type { LanguageModel, ModelMessage } from "ai"
import type { SourceItem } from "@threa/types"
import type { CostContext } from "../ai/ai"
import {
  AgentRuntime,
  type AgentRuntimeAI,
  type AgentRuntimeConfig,
  type AgentRuntimeResult,
  type NewMessageAwareness,
} from "./agent-runtime"
import type { AgentObserver } from "./agent-observer"
import type { AgentTool } from "./agent-tool"

// The turn contract's structural spine: dispatch mints a TurnRequest, routes it
// to the driver matching its delivery, and the driver runs the turn against the
// host's TurnSink. The request is everything a turn IS (model binding, prompt,
// history, toolset, sampling params); the sink is everything the turn touches in
// the host (the commit path, the trace observers, abort + interjection edges).
// `AgentRuntimeConfig` remains the loop's own constructor shape — this module
// types the seam in front of it without changing the loop.

export const TurnDeliveries = {
  /** First-party in-process turn next to plaintext (the companion). */
  PLAINTEXT: "plaintext",
  /** First-party turn behind sealed transport (the enclave). */
  SEALED: "sealed",
  /** Third-party harness driving its own agent over the bot wire. */
  EXTERNAL: "external",
} as const

export type TurnDelivery = (typeof TurnDeliveries)[keyof typeof TurnDeliveries]

/**
 * The commit payload every surface converges on. `sources` is required (empty
 * array means "none") so a host that ignores citations doesn't compile — the
 * same contract `AgentRuntimeConfig.sendMessage` already enforces. Sealed hosts
 * must carry the sources inside the sealed payload, never a cleartext field.
 */
export interface TurnCommit {
  content: string
  sources: SourceItem[]
}

export interface TurnCommitReceipt {
  messageId: string
  operation?: "created" | "edited"
}

/**
 * A capability a driver structurally cannot provide, declared with a user-facing
 * `reason` instead of being silently omitted (§2.2.4). A sink that passes this
 * for an optional edge is saying "I considered this and can't here" — so a gap
 * like the enclave's missing mid-turn interjection (UX-12) is a loud, renderable
 * product decision, not an `undefined` field. Drivers fold it to "no provider"
 * for the loop while the reason stays available to telemetry and the trace UI.
 */
export interface DeclaredUnsupported {
  readonly unsupported: true
  readonly reason: string
}

/** Declare an optional turn capability unsupported, with a renderable reason. */
export function declaredUnsupported(reason: string): DeclaredUnsupported {
  return { unsupported: true, reason }
}

/** Narrow an optional sink edge to its declared-unsupported sentinel. */
export function isDeclaredUnsupported(value: unknown): value is DeclaredUnsupported {
  return typeof value === "object" && value !== null && (value as { unsupported?: unknown }).unsupported === true
}

/**
 * The host edges a turn runs against — what persona-agent used to hand the loop
 * as raw closures. Only the commit path is mandatory; a minimal host (no trace,
 * no interjection) supplies just `commitMessage`.
 */
export interface TurnSink {
  /** Terminal action: deliver one committed message to the conversation. */
  commitMessage: (commit: TurnCommit) => Promise<TurnCommitReceipt>
  /** Event sink — trace projection, digest collection, OTEL. */
  observers?: AgentObserver[]
  /**
   * Mid-turn interjection (new-message awareness). A real provider lets the loop
   * reconsider on messages that land mid-turn; `declaredUnsupported(reason)` says
   * the host structurally can't (the enclave reads sealed history once — UX-12);
   * omitted means the host simply didn't wire it.
   */
  newMessages?: NewMessageAwareness | DeclaredUnsupported
  /** Hard cancellation: a returned reason aborts the turn (externally deleted/superseded sessions). */
  shouldAbort?: () => Promise<string | null>
  /** Cooperative per-tool cancellation (graceful partial results, not session failure). */
  toolSignalProvider?: (toolCallId: string, toolName: string) => AbortSignal | undefined
}

/**
 * One turn, as dispatch mints it: which delivery serves it, plus the loop's
 * inputs. The resolved `model` is host-bound (a sealed host resolves its own
 * from `modelString`), so drivers that cross a transport boundary put only the
 * string on the wire.
 */
export interface TurnRequest {
  delivery: TurnDelivery
  model: LanguageModel
  /** Original provider:model string for `model` — required alongside `costContext` for usage recording. */
  modelString?: string
  systemPrompt: string
  messages: ModelMessage[]
  tools: AgentTool[]
  maxTokens?: number | null
  temperature?: number | null
  maxIterations?: number
  initialContext?: AgentRuntimeConfig["initialContext"]
  telemetry?: AgentRuntimeConfig["telemetry"]
  costContext?: CostContext
  allowNoMessageOutput?: boolean
  validateFinalResponse?: AgentRuntimeConfig["validateFinalResponse"]
}

export type TurnResult = AgentRuntimeResult

export interface TurnDriver {
  /** The single delivery this driver serves; dispatch routes requests by it. */
  readonly delivery: TurnDelivery
  runTurn(request: TurnRequest, sink: TurnSink): Promise<TurnResult>
}

/**
 * Map a request + sink onto the loop's own constructor shape and run it. Shared
 * by every in-process-style driver — the companion in plaintext and the enclave
 * behind its sealing sink — which differ only by `delivery`, never by how the
 * request and sink reach `AgentRuntime`.
 */
function runTurnOnAgentRuntime(ai: AgentRuntimeAI, request: TurnRequest, sink: TurnSink): Promise<TurnResult> {
  const runtime = new AgentRuntime({
    ai,
    model: request.model,
    modelString: request.modelString,
    systemPrompt: request.systemPrompt,
    messages: request.messages,
    tools: request.tools,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    maxIterations: request.maxIterations,
    initialContext: request.initialContext,
    telemetry: request.telemetry,
    costContext: request.costContext,
    allowNoMessageOutput: request.allowNoMessageOutput,
    validateFinalResponse: request.validateFinalResponse,
    sendMessage: sink.commitMessage,
    observers: sink.observers,
    // A declared-unsupported interjection edge is a real "no provider" to the
    // loop; the reason rides the seam for rendering, never into the loop.
    newMessages: isDeclaredUnsupported(sink.newMessages) ? undefined : sink.newMessages,
    shouldAbort: sink.shouldAbort,
    toolSignalProvider: sink.toolSignalProvider,
  })
  return runtime.run()
}

/**
 * The plaintext driver: runs `AgentRuntime` in-process (the companion path).
 * Long-lived — construct once with the host's AI; each turn passes its own
 * request and sink.
 */
export class InProcessTurnDriver implements TurnDriver {
  readonly delivery: TurnDelivery = TurnDeliveries.PLAINTEXT

  constructor(private readonly deps: { ai: AgentRuntimeAI }) {}

  async runTurn(request: TurnRequest, sink: TurnSink): Promise<TurnResult> {
    if (request.delivery !== this.delivery) {
      throw new Error(`InProcessTurnDriver serves "${this.delivery}" turns; got "${request.delivery}"`)
    }
    return runTurnOnAgentRuntime(this.deps.ai, request, sink)
  }
}

/**
 * The sealed driver: runs the SAME `AgentRuntime` loop, but inside the enclave
 * next to decrypted plaintext, with a sealing sink (its commit and trace edges
 * seal under the stream SSK before crossing the HTTP callbacks). Constructed per
 * turn because the enclave's `AgentRuntimeAI` is itself per turn — it accumulates
 * that turn's token usage — unlike the companion's process-long-lived AI.
 */
export class EnclaveTurnDriver implements TurnDriver {
  readonly delivery: TurnDelivery = TurnDeliveries.SEALED

  constructor(private readonly deps: { ai: AgentRuntimeAI }) {}

  async runTurn(request: TurnRequest, sink: TurnSink): Promise<TurnResult> {
    if (request.delivery !== this.delivery) {
      throw new Error(`EnclaveTurnDriver serves "${this.delivery}" turns; got "${request.delivery}"`)
    }
    return runTurnOnAgentRuntime(this.deps.ai, request, sink)
  }
}
