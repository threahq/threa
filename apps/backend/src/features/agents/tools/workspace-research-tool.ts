import { z } from "zod"
import { AgentStepTypes, ToolPrivacyCategories } from "@threa/types"
import type { WorkspaceAgentResult } from "../researcher"
import { WORKSPACE_AGENT_TOTAL_BUDGET_MS } from "../researcher/config"
import { defineAgentTool, type AgentToolResult } from "../runtime"

/**
 * workspace_research is not a registered `AgentToolName` (it is never persona-
 * gated via enabledTools — availability follows trigger context), so it has no
 * `TOOL_CATEGORIES_BY_NAME` row. Its name and categories are declared here, on
 * the definition, like every other tool.
 */
export const WORKSPACE_RESEARCH_TOOL_NAME = "workspace_research"

const WorkspaceResearchSchema = z.object({
  query: z.string().describe("What information you need from the workspace"),
})

export type WorkspaceResearchInput = z.infer<typeof WorkspaceResearchSchema>

/**
 * Options passed from the tool layer into the workspace-agent callback. Carries
 * the abort signal (sourced from SessionAbortRegistry via AgentRuntime.toolSignalProvider),
 * the substep emission callback (sourced from AgentToolConfig.execute.onProgress),
 * and an absolute wall-clock deadline so the researcher knows when to return partial.
 */
export interface RunWorkspaceAgentOptions {
  signal: AbortSignal
  onSubstep: (text: string) => void
  deadlineAt: number
}

export interface WorkspaceResearchCallbacks {
  runWorkspaceAgent: (query: string, opts: RunWorkspaceAgentOptions) => Promise<WorkspaceAgentResult>
}

/**
 * Fallback AbortSignal for contexts where the runtime did not provide one
 * (tests, callers that haven't wired toolSignalProvider). Never fires.
 */
const NEVER_SIGNAL = new AbortController().signal

export function createWorkspaceResearchTool(callbacks: WorkspaceResearchCallbacks) {
  const { runWorkspaceAgent } = callbacks

  return defineAgentTool({
    name: WORKSPACE_RESEARCH_TOOL_NAME,
    description:
      "Retrieve relevant workspace memory (messages, memos, attachments) for the current conversation when you need additional context.",
    categories: [ToolPrivacyCategories.WORKSPACE],
    promptBlock: `## Workspace Research

You have a \`workspace_research\` tool to retrieve relevant workspace memory (past messages, memos, and shared attachments).

Use workspace_research when:
- The user references past decisions, conversations, or people in this workspace
- The user asks about a specific project, document, or file they've shared
- Answering correctly requires information that lives in workspace history (not general knowledge)

Do NOT use workspace_research for:
- Greetings, small talk, or acknowledgments (e.g. "hi", "thanks", "pie")
- General knowledge questions you can answer directly
- Simple clarification or rephrasing requests
- Questions where you clearly already have enough context

When you do call it, incorporate retrieved context naturally into your response. The tool may return \`partial: true\` if it was taking too long or the user clicked stop — handle that gracefully by using whatever context is available and acknowledging that your view might be incomplete.`,
    inputSchema: WorkspaceResearchSchema,

    execute: async (input, { signal, onProgress }): Promise<AgentToolResult> => {
      const deadlineAt = Date.now() + WORKSPACE_AGENT_TOTAL_BUDGET_MS
      const result = await runWorkspaceAgent(input.query, {
        signal: signal ?? NEVER_SIGNAL,
        onSubstep: (text) => onProgress?.(text),
        deadlineAt,
      })

      const partial = result.partial === true

      const sourceItems = result.sources
        .filter((s) => s.title && s.url)
        .map((s) => ({
          ...s,
          title: s.title,
          url: s.url,
          type: s.type as "web" | "workspace",
          snippet: s.snippet,
        }))

      // The LLM gets a compact status summary; the actual context goes into systemContext.
      // When partial, we tell the model so it can incorporate "we have some context, not all"
      // into its response. The substep log is included so the trace dialog can reconstruct
      // the phase timeline from persisted step.content after a browser refresh.
      const output = JSON.stringify({
        status: partial ? "partial" : "ok",
        partial,
        partialReason: partial ? (result.partialReason ?? null) : null,
        contextAdded: Boolean(result.retrievedContext?.trim()),
        sourceCount: sourceItems.length,
        memoCount: result.memos.length,
        messageCount: result.messages.length,
        attachmentCount: result.attachments?.length ?? 0,
        substeps: result.substeps,
      })

      return {
        output,
        sources: sourceItems,
        systemContext: result.retrievedContext?.trim() || undefined,
      }
    },

    trace: {
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      // formatContent returns the tool output verbatim. Because execute above serializes
      // the full substep log into output, the persisted step.content will contain it too,
      // giving browser-refresh stability for the trace dialog's phase timeline.
      formatContent: (_input, result) => {
        try {
          return result.output
        } catch {
          return "{}"
        }
      },
      extractSources: (_input, result) =>
        (result.sources ?? []).map((source) => {
          const s = source as WorkspaceAgentResult["sources"][number]

          return {
            type: s.traceType ?? (s.type === "web" ? "web" : "workspace"),
            title: s.title,
            url: s.url,
            snippet: s.snippet,
            memoId: s.memoId,
            streamId: s.streamId,
            streamName: s.streamName,
            messageId: s.messageId,
            authorName: s.authorName,
          }
        }),
    },
  })
}
