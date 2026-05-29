import type { SourceItem } from "@threa/types"
import { isAbortError, mergeSourceItems, type AI, type CostContext } from "@threa/agent-runtime"
import { AgentRuntime, type AgentTool } from "../runtime"
import { composeAbortSignal } from "../../../lib/abort-signal"
import { COMPONENT_PATHS, type ConfigResolver, type GeneralResearcherConfig } from "../../../lib/ai/config-resolver"
import { logger } from "../../../lib/logger"
import { ResearchProgressObserver } from "./progress-observer"
import {
  GENERAL_RESEARCH_MAX_BRIEF_CHARS,
  GENERAL_RESEARCH_MAX_ITERATIONS,
  GENERAL_RESEARCH_SYSTEM_PROMPT,
  GENERAL_RESEARCH_TEMPERATURE,
} from "./config"

/** Cap on sources surfaced back to the persona, keeping the citation list focused. */
const MAX_RESULT_SOURCES = 30

export interface GeneralResearchSubstep {
  text: string
  at: string
}

export interface GeneralResearchResult {
  /**
   * Synthesised, cited research brief. Consumed by the persona as systemContext.
   * Empty only when the run was aborted before any brief was produced.
   */
  brief: string
  sources: SourceItem[]
  substeps: GeneralResearchSubstep[]
  /**
   * Set when the run stopped early (user stop or wall-clock deadline). Mirrors
   * {@link WorkspaceAgentResult.partial}; the tool layer derives its status
   * string from this rather than carrying a second redundant field.
   */
  partial?: boolean
  partialReason?: "user_abort" | "timeout"
}

export interface GeneralResearchInput {
  workspaceId: string
  /** The question delegated by the persona. */
  query: string
  /** Optional compact conversation context to ground the research. */
  conversationContext?: string
  /**
   * The tools the sub-agent may drive. Built by the persona layer via
   * `buildToolSet` with the research tool policy — web, URL reads, workspace
   * search primitives, and connected integrations. Excludes workspace_research
   * and send_message.
   */
  tools: AgentTool[]
  /** Cost context forwarded to every inner AI call for usage attribution. */
  costContext: CostContext
  /** Cooperative cancellation from the session abort registry (user stop). */
  signal: AbortSignal
  /** Absolute wall-clock deadline (ms epoch) after which we return partial. */
  deadlineAt: number
  /** Live phase updates surfaced on the persona's research trace step. */
  onSubstep: (text: string) => void
}

export interface GeneralResearcherDeps {
  ai: AI
  configResolver: ConfigResolver
}

/**
 * Bounded, tool-driven research sub-agent.
 *
 * Wraps the SAME {@link AgentRuntime} loop the persona uses, rather than a
 * bespoke orchestrator: a research-specific system prompt, the persona's
 * primitive tools (minus workspace_research, to avoid nesting sub-agents), a
 * capturing `sendMessage` (the final brief is captured, never posted), and a
 * wall-clock deadline enforced cooperatively. On abort or timeout it returns
 * whatever it has synthesised so far as a partial result — the persona loop
 * keeps going, mirroring the workspace researcher's stop semantics.
 */
export class GeneralResearcher {
  constructor(private readonly deps: GeneralResearcherDeps) {}

  async research(input: GeneralResearchInput): Promise<GeneralResearchResult> {
    const config = await this.deps.configResolver.resolve<GeneralResearcherConfig>(COMPONENT_PATHS.GENERAL_RESEARCHER)
    const modelId = config.modelId
    const model = this.deps.ai.getLanguageModel(modelId)
    const parsed = this.deps.ai.parseModel(modelId)

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

    // One run-level signal: aborts at the deadline OR when the session is
    // stopped, whichever comes first. Handed to every tool's execute so a tool
    // in flight at the deadline is cancelled. Leak-safe cleanup in `finally`.
    const { signal: runSignal, cleanup } = composeAbortSignal({
      parent: input.signal,
      timeoutMs: Math.max(0, input.deadlineAt - Date.now()),
      timeoutReason: "research deadline",
    })

    const runtime = new AgentRuntime({
      ai: this.deps.ai,
      model,
      modelString: modelId,
      systemPrompt: GENERAL_RESEARCH_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
      tools: input.tools,
      temperature: config.temperature ?? GENERAL_RESEARCH_TEMPERATURE,
      maxIterations: config.maxIterations ?? GENERAL_RESEARCH_MAX_ITERATIONS,
      costContext: input.costContext,
      telemetry: {
        functionId: "general-research-loop",
        metadata: {
          model_id: parsed.modelId,
          model_provider: parsed.modelProvider,
          model_name: parsed.modelName,
        },
      },
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
      // result.sources is the runtime's own deduped accumulation across every
      // tool call — the canonical citation list. Just cap it.
      const sources = result.sources.slice(0, MAX_RESULT_SOURCES)
      if (!brief) {
        // Loop finished without producing a brief (rare). Treat as partial so the
        // persona acknowledges incomplete research rather than asserting an answer.
        return { brief: "", sources, substeps, partial: true, partialReason: "timeout" }
      }
      return { brief, sources, substeps }
    } catch (err) {
      const aborted = input.signal.aborted
      const timedOut = Date.now() >= input.deadlineAt
      if (aborted || timedOut || isAbortError(err)) {
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
}

function buildUserPrompt(input: GeneralResearchInput): string {
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
