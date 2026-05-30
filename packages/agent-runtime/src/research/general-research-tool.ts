import { z } from "zod"
import { AgentStepTypes } from "@threa/types"
import { defineAgentTool, type AgentToolResult } from "../runtime/agent-tool"
import { GENERAL_RESEARCH_TOTAL_BUDGET_MS } from "./config"
import type { GeneralResearchResult } from "./general-researcher"

const GeneralResearchSchema = z.object({
  query: z
    .string()
    .describe(
      "The question to research. State it fully and self-contained — the researcher does not see the chat, only this query."
    ),
})

export type GeneralResearchToolInput = z.infer<typeof GeneralResearchSchema>

/**
 * Options passed from the tool layer into the general-researcher callback: the
 * abort signal (from SessionAbortRegistry via AgentRuntime.toolSignalProvider),
 * the substep emission callback (from AgentToolConfig.execute.onProgress), and an
 * absolute wall-clock deadline.
 */
export interface RunGeneralResearchOptions {
  signal: AbortSignal
  onSubstep: (text: string) => void
  deadlineAt: number
}

export interface GeneralResearchCallbacks {
  runGeneralResearch: (query: string, opts: RunGeneralResearchOptions) => Promise<GeneralResearchResult>
}

/** Fallback signal for callers that did not wire toolSignalProvider (tests). Never fires. */
const NEVER_SIGNAL = new AbortController().signal

/**
 * Bounded, multi-step research across workspace knowledge, the public web, and
 * connected integrations (GitHub, Linear). Delegates to the general researcher
 * sub-agent and folds its synthesised brief into the caller's context, the same
 * way `workspace_research` does for workspace-only retrieval. The callback
 * indirection lets each host (backend persona / enclave) supply its own
 * researcher binding while sharing this one tool definition.
 */
export function createGeneralResearchTool(callbacks: GeneralResearchCallbacks) {
  const { runGeneralResearch } = callbacks

  return defineAgentTool({
    name: "general_research",
    description:
      'Your default tool for any research, news, or current-events question — reach for it whenever the user wants current information, an overview of a topic, recent developments, or anything you would otherwise answer by running web searches yourself. There is no complexity threshold: a single broad question like "what\'s new in AI" qualifies just as much as a multi-source one. It runs bounded (~2 minute) research across the public web, workspace knowledge, and connected integrations (GitHub, Linear) in one pass and returns a synthesised, cited brief. Only reach for a single direct tool instead when it clearly suffices: web_search or read_url for a quick one-fact lookup, workspace_research for workspace-only recall, or a specific GitHub/Linear tool.',
    inputSchema: GeneralResearchSchema,

    execute: async (input, { signal, onProgress }): Promise<AgentToolResult> => {
      const deadlineAt = Date.now() + GENERAL_RESEARCH_TOTAL_BUDGET_MS
      const result = await runGeneralResearch(input.query, {
        signal: signal ?? NEVER_SIGNAL,
        onSubstep: (text) => onProgress?.(text),
        deadlineAt,
      })

      const partial = result.partial === true
      const sourceItems = result.sources.filter((s) => s.title && s.url)

      // The LLM gets a compact status summary; the synthesised brief goes into
      // systemContext (injected into the caller's system prompt next turn,
      // exactly like workspace_research). The substep log rides along in `output`
      // so the trace dialog's phase timeline survives a browser refresh.
      const output = JSON.stringify({
        status: partial ? "partial" : "ok",
        partial,
        partialReason: partial ? (result.partialReason ?? null) : null,
        briefAdded: Boolean(result.brief.trim()),
        sourceCount: sourceItems.length,
        substeps: result.substeps,
      })

      return {
        output,
        sources: sourceItems,
        systemContext: result.brief.trim() || undefined,
      }
    },

    trace: {
      stepType: AgentStepTypes.RESEARCH,
      formatContent: (_input, result) => {
        // The trace carries the full synthesised brief so it stays inspectable
        // in the trace dialog even when the caller's reply folds it in poorly.
        // The LLM-facing `output` stays lean — the model already receives the
        // brief via systemContext next turn, so we never duplicate it there.
        try {
          const summary = JSON.parse(result.output) as Record<string, unknown>
          const brief = result.systemContext?.trim()
          return JSON.stringify(brief ? { ...summary, brief } : summary)
        } catch {
          return result.output
        }
      },
      extractSources: (_input, result) =>
        (result.sources ?? []).map((source) => ({
          // SourceType ("web" | "workspace" | "github") is a subset of TraceSourceType,
          // so the source type carries through directly; default to "web".
          type: source.type ?? "web",
          title: source.title,
          url: source.url,
          snippet: source.snippet,
        })),
    },
  })
}
