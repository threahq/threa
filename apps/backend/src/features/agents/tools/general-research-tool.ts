import { z } from "zod"
import { AgentStepTypes } from "@threa/types"
import type { GeneralResearchResult } from "../general-researcher"
import { GENERAL_RESEARCH_TOTAL_BUDGET_MS } from "../general-researcher"
import { defineAgentTool, type AgentToolResult } from "../runtime"

const GeneralResearchSchema = z.object({
  query: z
    .string()
    .describe(
      "The question to research. State it fully and self-contained — the researcher does not see the chat, only this query."
    ),
})

export type GeneralResearchInput = z.infer<typeof GeneralResearchSchema>

/**
 * Options passed from the tool layer into the general-researcher callback.
 * Mirrors {@link RunWorkspaceAgentOptions}: the abort signal (from
 * SessionAbortRegistry via AgentRuntime.toolSignalProvider), the substep
 * emission callback (from AgentToolConfig.execute.onProgress), and an absolute
 * wall-clock deadline.
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
 * sub-agent and folds its synthesised brief into the persona's context, the
 * same way `workspace_research` does for workspace-only retrieval.
 */
export function createGeneralResearchTool(callbacks: GeneralResearchCallbacks) {
  const { runGeneralResearch } = callbacks

  return defineAgentTool({
    name: "general_research",
    description:
      "Run bounded (~2 minute) research across workspace knowledge, the public web, and connected integrations (GitHub, Linear) in one pass, returning a synthesised, cited brief. Use this when answering well needs several lookups or spans more than one source. Prefer a single direct tool (web_search, read_url, a GitHub/Linear tool, or workspace_research for workspace-only recall) when one surface clearly suffices.",
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
      // systemContext (injected into the persona's system prompt next turn,
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
        try {
          return result.output
        } catch {
          return "{}"
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
