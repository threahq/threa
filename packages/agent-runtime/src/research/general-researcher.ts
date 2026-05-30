import type { LanguageModel } from "ai"
import type { SourceItem } from "@threa/types"
import type { CostContext } from "../ai/ai"
import { AgentRuntime, mergeSourceItems } from "../runtime/agent-runtime"
import type { AgentRuntimeAI } from "../runtime/agent-runtime"
import type { AgentTool } from "../runtime/agent-tool"
import { logger } from "../logger"
import { composeAbortSignal } from "./research-support"
import { ResearchProgressObserver } from "./progress-observer"
import {
  GENERAL_RESEARCH_MAX_BRIEF_CHARS,
  GENERAL_RESEARCH_MAX_ITERATIONS,
  GENERAL_RESEARCH_SYSTEM_PROMPT,
  GENERAL_RESEARCH_TEMPERATURE,
} from "./config"

/** Cap on sources surfaced back to the caller, keeping the citation list focused. */
const MAX_RESULT_SOURCES = 30

export interface GeneralResearchSubstep {
  text: string
  at: string
}

export interface GeneralResearchResult {
  /**
   * Synthesised, cited research brief. Consumed by the caller as systemContext.
   * Empty only when the run was aborted before any brief was produced.
   */
  brief: string
  sources: SourceItem[]
  substeps: GeneralResearchSubstep[]
  /**
   * Set when the run stopped early (user stop or wall-clock deadline). The tool
   * layer derives its status string from this rather than carrying a second
   * redundant field.
   */
  partial?: boolean
  partialReason?: "user_abort" | "timeout"
}

/**
 * Everything the bounded research loop needs, with model resolution already done
 * by the caller. The backend resolves these through its ConfigResolver + AI; the
 * enclave supplies its own `AgentRuntimeAI` over a single OpenRouter connection
 * and the model id from the assignment — neither path pulls the heavy AI
 * provider layer into this module, so it stays importable on the enclave's
 * OTEL-free barrel.
 */
export interface RunGeneralResearchDeps {
  /** The minimal generate surface the inner loop calls. */
  ai: AgentRuntimeAI
  /** Resolved model handle (opaque to the enclave AI, meaningful to the backend SDK). */
  model: LanguageModel
  /** Canonical model string (e.g. `openrouter:anthropic/...`) the loop forwards as `modelString`. */
  modelString: string
  /** Telemetry metadata for the inner loop's AI calls (INV-19). Optional: the enclave omits it. */
  telemetry?: { functionId: string; metadata?: Record<string, string | number | boolean> }
  /** Sampling temperature; falls back to the shared default. */
  temperature?: number
  /** Max agent-loop iterations; falls back to the shared default. */
  maxIterations?: number
}

export interface GeneralResearchRunInput {
  /** For diagnostics only — the loop itself is workspace-agnostic. */
  workspaceId?: string
  /** The question delegated by the caller. */
  query: string
  /** Optional compact conversation context to ground the research. */
  conversationContext?: string
  /**
   * The tools the sub-agent may drive. The backend passes the persona's research
   * tool policy (web, URL reads, workspace search, integrations); the enclave
   * passes the web-only subset. Excludes workspace_research and send_message.
   */
  tools: AgentTool[]
  /** Cost context forwarded to every inner AI call for usage attribution. */
  costContext?: CostContext
  /** Cooperative cancellation from the caller (user stop). */
  signal: AbortSignal
  /** Absolute wall-clock deadline (ms epoch) after which we return partial. */
  deadlineAt: number
  /** Live phase updates surfaced on the caller's research trace. */
  onSubstep: (text: string) => void
}

/**
 * Bounded, tool-driven research sub-agent — the runtime-agnostic core.
 *
 * Wraps the SAME {@link AgentRuntime} loop callers use, rather than a bespoke
 * orchestrator: a research-specific system prompt, the caller's primitive tools
 * (minus workspace_research, to avoid nesting sub-agents), a capturing
 * `sendMessage` (the final brief is captured, never posted), and a wall-clock
 * deadline enforced cooperatively. On abort or timeout it returns whatever it
 * has synthesised so far as a partial result — the calling loop keeps going.
 */
export async function runGeneralResearch(
  deps: RunGeneralResearchDeps,
  input: GeneralResearchRunInput
): Promise<GeneralResearchResult> {
  const substeps: GeneralResearchSubstep[] = []
  const recordSubstep = (text: string) => {
    substeps.push({ text, at: new Date().toISOString() })
    try {
      input.onSubstep(text)
    } catch (err) {
      logger.warn({ err, text }, "general research onSubstep callback threw; swallowing")
    }
  }

  const observer = new ResearchProgressObserver(recordSubstep)
  // Holder object (not a bare `let`) so TS doesn't narrow the captured brief to
  // `null` after the run — it's mutated inside the sendMessage closure.
  const sink: { value: { content: string; sources?: SourceItem[] } | null } = { value: null }

  // One run-level signal: aborts at the deadline OR when the session is stopped,
  // whichever comes first. Handed to every tool's execute so a tool in flight at
  // the deadline is cancelled. Leak-safe cleanup in `finally`.
  const { signal: runSignal, cleanup } = composeAbortSignal({
    parent: input.signal,
    timeoutMs: Math.max(0, input.deadlineAt - Date.now()),
    timeoutReason: "research deadline",
  })

  const runtime = new AgentRuntime({
    ai: deps.ai,
    model: deps.model,
    modelString: deps.modelString,
    systemPrompt: GENERAL_RESEARCH_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(input) }],
    tools: input.tools,
    temperature: deps.temperature ?? GENERAL_RESEARCH_TEMPERATURE,
    maxIterations: deps.maxIterations ?? GENERAL_RESEARCH_MAX_ITERATIONS,
    costContext: input.costContext,
    telemetry: deps.telemetry,
    observers: [observer],
    sendMessage: async (msg) => {
      sink.value = { content: msg.content, sources: msg.sources }
      // Synthetic id — the brief is captured here, never persisted as a message.
      return { messageId: "general_research_brief", operation: "created" as const }
    },
    shouldAbort: async () => {
      if (input.signal.aborted) return "user_abort"
      if (Date.now() >= input.deadlineAt) return "timeout"
      return null
    },
    toolSignalProvider: () => runSignal,
  })

  try {
    const result = await runtime.run()
    const brief = clip(sink.value?.content ?? result.sentContents.at(-1) ?? "")
    // result.sources is the runtime's own deduped accumulation across every tool
    // call — the canonical citation list. Just cap it.
    const sources = result.sources.slice(0, MAX_RESULT_SOURCES)
    if (!brief) {
      // Loop finished without producing a brief (rare). Treat as partial so the
      // caller acknowledges incomplete research rather than asserting an answer.
      return { brief: "", sources, substeps, partial: true, partialReason: "timeout" }
    }
    return { brief, sources, substeps }
  } catch (err) {
    const aborted = input.signal.aborted
    const timedOut = Date.now() >= input.deadlineAt
    if (aborted || timedOut || isAbortLikeError(err)) {
      const reason: "user_abort" | "timeout" = aborted ? "user_abort" : "timeout"
      recordSubstep(
        reason === "user_abort"
          ? "Stopped on request. Returning partial findings…"
          : "Time budget reached. Returning partial findings…"
      )
      return {
        // No runtime result on the abort path — combine any sources the brief
        // carried with what the observer accumulated from completed tools.
        brief: clip(sink.value?.content ?? ""),
        sources: mergeSourceItems(sink.value?.sources ?? [], observer.sources).slice(0, MAX_RESULT_SOURCES),
        substeps,
        partial: true,
        partialReason: reason,
      }
    }
    logger.error({ err, workspaceId: input.workspaceId }, "General research failed")
    throw err
  } finally {
    cleanup()
  }
}

/**
 * Local abort-shape check. Mirrors the AI wrapper's `isAbortError` but lives here
 * so the enclave's OTEL-free barrel can import the researcher without pulling in
 * the LangChain/OpenRouter provider layer that `ai/ai.ts` carries.
 */
function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const name = (err as { name?: unknown }).name
  return name === "AbortError" || name === "TimeoutError"
}

function buildUserPrompt(input: GeneralResearchRunInput): string {
  const parts = [`Question:\n${input.query}`]
  if (input.conversationContext?.trim()) {
    parts.push(`Conversation context:\n${input.conversationContext.trim()}`)
  }
  parts.push("Research this now, then call send_message once with your synthesised, cited brief.")
  return parts.join("\n\n")
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > GENERAL_RESEARCH_MAX_BRIEF_CHARS
    ? `${trimmed.slice(0, GENERAL_RESEARCH_MAX_BRIEF_CHARS)}…`
    : trimmed
}
