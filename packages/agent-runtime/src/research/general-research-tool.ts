import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
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

/**
 * Which surfaces the bound researcher can actually reach. Drives the tool's
 * wire description and prompt prose so a host never advertises reach it does
 * not have: the backend persona's researcher spans workspace + web +
 * integrations, while the enclave's drives the web subset only.
 */
export type GeneralResearchScope = "workspace-web-integrations" | "web-only"

export interface GeneralResearchCallbacks {
  runGeneralResearch: (query: string, opts: RunGeneralResearchOptions) => Promise<GeneralResearchResult>
  scope: GeneralResearchScope
}

const RESEARCH_PROSE_BY_SCOPE: Record<GeneralResearchScope, { description: string; promptBlock: string }> = {
  "workspace-web-integrations": {
    description:
      'Your default tool for any research, news, or current-events question — reach for it whenever the user wants current information, an overview of a topic, recent developments, or anything you would otherwise answer by running web searches yourself. There is no complexity threshold: a single broad question like "what\'s new in AI" qualifies just as much as a multi-source one. It runs bounded (~2 minute) research across the public web, workspace knowledge, and connected integrations (GitHub, Linear) in one pass and returns a synthesised, cited brief. Only reach for a single direct tool instead when it clearly suffices: web_search or read_url for a quick one-fact lookup, workspace_research for workspace-only recall, or a specific GitHub/Linear tool.',
    promptBlock: `## General Research

You have a \`general_research\` tool — your default for any research, news, or current-events question. It runs bounded (~2 minute) research across the public web, workspace memory, and connected integrations (GitHub, Linear) in one pass and returns a synthesised, cited brief.

${sharedResearchGuidance(
  "Reach for a simpler tool only when it plainly suffices — `workspace_research` for workspace-only recall, `web_search`/`read_url` for a single quick fact, or a specific GitHub/Linear tool."
)}`,
  },
  "web-only": {
    description:
      'Your default tool for any research, news, or current-events question — reach for it whenever the user wants current information, an overview of a topic, recent developments, or anything you would otherwise answer by running web searches yourself. There is no complexity threshold: a single broad question like "what\'s new in AI" qualifies just as much as a multi-source one. It runs bounded (~2 minute) research across the public web in one pass and returns a synthesised, cited brief. Only reach for web_search or read_url instead when a quick one-fact lookup clearly suffices.',
    promptBlock: `## General Research

You have a \`general_research\` tool — your default for any research, news, or current-events question. It runs bounded (~2 minute) research across the public web in one pass and returns a synthesised, cited brief.

${sharedResearchGuidance(
  "Reach for a simpler tool only when it plainly suffices — `web_search`/`read_url` for a single quick fact."
)}`,
  },
}

function sharedResearchGuidance(simplerToolSentence: string): string {
  return `Reach for general_research whenever the user:
- Asks about news, recent developments, or "what's happening with X"
- Wants an overview of a topic, a comparison, or the current state of something
- Asks anything you would otherwise answer by running one or more web searches yourself

Do not judge whether the question is "complex enough" or "spans multiple sources" — there is no such threshold. A broad, open-ended prompt (an invitation to explore a topic, catch up on a field, or summarise what's been happening) is exactly what this tool is for, just as much as a precise multi-source one. When a question is research- or news-flavoured and you are choosing between this and searching by hand, use general_research: it searches more thoroughly and comes back with cited sources.

${simplerToolSentence} Do not reach for general_research for greetings, small talk, or questions you can already answer from your own knowledge.

Pass a fully self-contained \`query\`: the researcher does not see this conversation, only the query you give it. When the brief comes back it is added to your own context for this turn — read it and answer the user directly from it, in your own voice, keeping its cited sources. Never tell the user the brief was "attached to system context" or otherwise narrate the plumbing; just give them the answer. The brief may come back \`partial: true\` if the user stopped it or it ran out of time — answer with what it found and note that the view may be incomplete.`
}

/** Fallback signal for callers that did not wire toolSignalProvider (tests). Never fires. */
const NEVER_SIGNAL = new AbortController().signal

/**
 * Bounded, multi-step research delegated to the general researcher sub-agent;
 * its synthesised brief folds into the caller's context, the same way
 * `workspace_research` does for workspace-only retrieval. The callback
 * indirection lets each host (backend persona / enclave) supply its own
 * researcher binding while sharing this one tool definition; `scope` keeps the
 * advertised reach honest per host.
 */
export function createGeneralResearchTool(callbacks: GeneralResearchCallbacks) {
  const { runGeneralResearch, scope } = callbacks
  const prose = RESEARCH_PROSE_BY_SCOPE[scope]

  return defineAgentTool({
    name: "general_research",
    description: prose.description,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GENERAL_RESEARCH],
    promptBlock: prose.promptBlock,
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
