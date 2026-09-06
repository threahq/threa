import type { Tool } from "ai"
import { z } from "zod"
import {
  ToolTiers,
  TOOL_TIERS_BY_NAME,
  tierOfTool,
  type AgentStepType,
  type AgentToolEffect,
  type ToolPrivacyCategory,
  type ToolTier,
  type TraceSource,
  type SourceItem,
} from "@threahq/types"

export interface AgentToolResult {
  /** What the LLM sees as the tool result */
  output: string
  /**
   * Media for vision/file-capable models — injected as user messages, since
   * tool results themselves are text-only on the chat-completions wire.
   * `image` carries a data URL (or https URL); `file` carries raw base64 +
   * media type (e.g. a PDF the model reads natively).
   */
  multimodal?: Array<
    { type: "image"; url: string } | { type: "file"; data: string; mediaType: string; filename?: string }
  >
  /** Citation sources accumulated and attached to sent messages */
  sources?: SourceItem[]
  /** Injected into system prompt on next iteration (workspace research context) */
  systemContext?: string
}

/**
 * Execution phase controls tool ordering within a single LLM turn.
 * - "early": runs first (e.g., web_search — collect sources before other tools)
 * - "normal": runs after early tools (default)
 */
export type ExecutionPhase = "early" | "normal"

export interface AgentToolConfig<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  /**
   * Privacy categories this tool falls into, consumed by per-stream tool
   * policies via `areToolCategoriesAllowed`. Tools with a registered
   * `AgentToolName` source their value from `TOOL_CATEGORIES_BY_NAME` so the
   * name-keyed table stays the single source of truth. An EMPTY array marks a
   * conversation-local tool (reads nothing beyond what the model already
   * sees) that no policy ever gates.
   */
  categories: readonly ToolPrivacyCategory[]
  /**
   * How much this call can cost the user if the model is wrong about wanting
   * it. Tier 2+ is reviewed by the host's guardian before it executes; tier 1
   * runs straight through.
   *
   * NOT written at definition sites — `defineAgentTool` resolves it from
   * `TOOL_TIERS_BY_NAME`, so a registered tool cannot be given a tier that
   * disagrees with the table. `categories` is passed per-site for historical
   * reasons; deriving the tier centrally is the stronger arrangement, because
   * the only way to change a tool's tier is to edit the table every reviewer
   * already watches.
   *
   * Unregistered host-local tools (the enclave's in-process readers) resolve to
   * tier 1: they read what the model already sees and write nothing.
   */
  tier?: ToolTier
  /**
   * System-prompt prose advertising this tool: a complete `## Section` block
   * (no leading/trailing blank lines). Hosts assemble the prompt's tool
   * sections from the ACTUAL built toolset via `buildToolPromptSections`, so
   * a tool's prose can never drift from its availability. Omitted → the tool
   * is announced only through its wire `description`.
   */
  promptBlock?: string
  inputSchema: TSchema
  execute: (
    input: z.infer<TSchema>,
    opts: {
      toolCallId: string
      /**
       * Emit an ephemeral substep text update. Tools that want to show live progress
       * during execution call this with human-readable phase text. The runtime forwards
       * each call as a `tool:progress` AgentEvent which the TraceProjector translates
       * to a socket emission (no DB write). Persistence happens at tool completion via the
       * trace.formatContent path if the tool's result embeds the substep log.
       */
      onProgress?: (substep: string) => void
      /**
       * Optional AbortSignal sourced from the runtime's toolSignalProvider. Tools should
       * check this at safe checkpoints and return partial results gracefully when aborted.
       * NEVER repurposed from shouldAbort — that mechanism is fatal to the session.
       */
      signal?: AbortSignal
    }
  ) => Promise<AgentToolResult>
  /** Controls execution ordering within a single LLM turn. Defaults to "normal". */
  executionPhase?: ExecutionPhase
  trace: {
    stepType: AgentStepType
    /**
     * When true, the tool's execution is kept out of the user-facing session
     * trace. Used for lightweight workspace lookup tools whose individual
     * results are noise in the trace dialog — the deep `workspace_research`
     * tool captures the aggregate picture instead.
     */
    hidden?: boolean
    formatContent: (input: z.infer<TSchema>, result: AgentToolResult) => string
    extractSources?: (input: z.infer<TSchema>, result: AgentToolResult) => TraceSource[]
    /**
     * What this call wrote that the conversation does not already show.
     *
     * Authoritative when present, `[]` included: tools catch their own failures
     * and still return a successful result, so a declaring tool is the only
     * thing that knows whether the write happened. Absent means the name-keyed
     * MUTATING_TOOLS fallback decides.
     */
    effects?: (input: z.infer<TSchema>, result: AgentToolResult) => AgentToolEffect[]
  }
}

export interface AgentTool {
  readonly name: string
  readonly config: AgentToolConfig
}

export function defineAgentTool<TSchema extends z.ZodTypeAny>(config: AgentToolConfig<TSchema>): AgentTool {
  if (config.tier !== undefined) {
    throw new Error(
      `Tool "${config.name}" sets \`tier\` at its definition site. The tier comes from TOOL_TIERS_BY_NAME; remove it.`
    )
  }
  return { name: config.name, config: { ...config, tier: tierOfTool(config.name) } as AgentToolConfig }
}

/**
 * The tier a built tool executes at.
 *
 * Falls back to the name-keyed table, NOT to tier 1. `defineAgentTool` stamps
 * `tier` on everything it builds, but an `AgentTool` is a plain structural type
 * — a host that assembles the literal itself, or one compiled against a
 * pre-tier `@threahq/types`, produces a registered tool with no `tier`. Defaulting
 * that to `UNCHECKED` would silently hand a guarded tool an unguarded path;
 * re-reading the table by name makes the table the answer either way. An
 * unregistered name is genuinely host-local and tier 1.
 */
export function tierOfBuiltTool(tool: AgentTool): ToolTier {
  // The TABLE WINS for a registered name — `config.tier` is only consulted for
  // names the table does not know. `defineAgentTool` refuses to build a tool
  // that declares its own tier, but `AgentTool` is a structural type: a host
  // assembling the literal directly can set `name: "delegate_task", tier: 1`
  // and, if `config.tier` were preferred, hand a guarded tool an unguarded
  // path. Preferring the table makes that literal's claim inert.
  if (tool.name in TOOL_TIERS_BY_NAME) return tierOfTool(tool.name)
  return tool.config.tier ?? ToolTiers.UNCHECKED
}

/**
 * Join the prompt blocks of the ACTUAL built toolset, in toolset order. This
 * is the single tool-prose assembler for every host: prose rides each tool's
 * definition, so a tool that wasn't built (missing deps, per-stream policy,
 * persona gating) is never advertised, and a tool added to one host can't be
 * forgotten in another's prompt.
 */
export function buildToolPromptSections(tools: AgentTool[]): string {
  return tools
    .map((t) => t.config.promptBlock)
    .filter((block): block is string => Boolean(block))
    .join("\n\n")
}

// Schema only, no execute — the runtime executes tools manually.
export function toVercelToolDefs(tools: AgentTool[]): Record<string, Tool<any, any>> {
  const defs: Record<string, Tool<any, any>> = {}
  for (const t of tools) {
    defs[t.name] = {
      description: t.config.description,
      inputSchema: t.config.inputSchema,
    } as Tool<any, any>
  }
  return defs
}
