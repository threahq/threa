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
 * The host edges a turn runs against — what persona-agent used to hand the loop
 * as raw closures. Only the commit path is mandatory; a minimal host (no trace,
 * no interjection) supplies just `commitMessage`.
 */
export interface TurnSink {
  /** Terminal action: deliver one committed message to the conversation. */
  commitMessage: (commit: TurnCommit) => Promise<TurnCommitReceipt>
  /** Event sink — trace projection, digest collection, OTEL. */
  observers?: AgentObserver[]
  /** Mid-turn interjection (new-message awareness). Omitted → the host can't see mid-turn messages. */
  newMessages?: NewMessageAwareness
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

    const runtime = new AgentRuntime({
      ai: this.deps.ai,
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
      newMessages: sink.newMessages,
      shouldAbort: sink.shouldAbort,
      toolSignalProvider: sink.toolSignalProvider,
    })
    return runtime.run()
  }
}
