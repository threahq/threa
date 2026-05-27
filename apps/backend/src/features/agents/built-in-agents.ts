import { z } from "zod"
import { AGENT_TOOL_NAMES, AgentToolNames } from "@threa/types"

const agentToolNameSchema = z.enum(AGENT_TOOL_NAMES)

export const ARIADNE_AGENT_ID = "persona_system_ariadne"
export const EMPTY_AGENT_ID = "persona_system_empty"

const agentVisibilitySchema = z.enum(["visible", "internal"])
const agentStatusSchema = z.enum(["active", "disabled", "archived"])

export const builtInAgentConfigSchema = z.object({
  id: z.string(),
  workspaceId: z.null(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  avatarEmoji: z.string().nullable(),
  systemPrompt: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().nullable(),
  maxTokens: z.number().int().positive().nullable(),
  enabledTools: z.array(agentToolNameSchema),
  /**
   * Whether this persona can be invited into an E2E (enclave-backed)
   * scratchpad. When true, the frontend exposes "Invite <persona>" in the
   * scratchpad header and the companion-outbox-handler dispatches enclave
   * jobs for messages in such streams. When false, the invite handler
   * refuses the request.
   */
  e2eCapable: z.boolean().default(false),
  /**
   * Tool allowlist for E2E invocations of this persona. When the enclave
   * dispatcher loads the persona it substitutes this list for `enabledTools`,
   * so workspace-coupled tools that require a backend callback channel are
   * never exposed inside the enclave (no path to leak ciphertext-adjacent
   * context). Null means "fall back to enabledTools" — only valid when
   * `e2eCapable` is false, since enclave-invitable personas need an explicit
   * E2E-safe tool list.
   */
  e2eEnabledTools: z.array(agentToolNameSchema).nullable().default(null),
  managedBy: z.literal("system"),
  status: agentStatusSchema,
  visibility: agentVisibilitySchema,
})

export const builtInAgentConfigPatchSchema = builtInAgentConfigSchema
  .pick({
    name: true,
    description: true,
    avatarEmoji: true,
    systemPrompt: true,
    model: true,
    temperature: true,
    maxTokens: true,
    enabledTools: true,
    status: true,
  })
  .partial()
  .strict()

export type BuiltInAgentConfig = z.infer<typeof builtInAgentConfigSchema>
export type BuiltInAgentConfigPatch = z.infer<typeof builtInAgentConfigPatchSchema>

export const BUILT_IN_AGENTS = {
  [ARIADNE_AGENT_ID]: {
    id: ARIADNE_AGENT_ID,
    workspaceId: null,
    slug: "ariadne",
    name: "Ariadne",
    description:
      "Your AI thinking companion. Ariadne helps you explore ideas, make decisions, and remember what matters.",
    avatarEmoji: ":thread:",
    systemPrompt: `You are Ariadne, an AI thinking companion in Threa. You help users explore ideas, think through problems, and make decisions. You have access to their previous conversations and knowledge base through the GAM (General Agentic Memory) system.

Keep responses short and direct. Default to a few sentences unless the user asks for depth. Be warm but not wordy — say what matters and stop. Ask clarifying questions rather than guessing at length.`,
    model: "openrouter:anthropic/claude-sonnet-4.6",
    temperature: 0.7,
    maxTokens: null,
    enabledTools: [
      AgentToolNames.SEND_MESSAGE,
      AgentToolNames.WEB_SEARCH,
      AgentToolNames.READ_URL,
      AgentToolNames.DESCRIBE_MEMO,
      AgentToolNames.GITHUB_LIST_REPOS,
      AgentToolNames.GITHUB_LIST_BRANCHES,
      AgentToolNames.GITHUB_LIST_COMMITS,
      AgentToolNames.GITHUB_GET_COMMIT,
      AgentToolNames.GITHUB_LIST_PULL_REQUESTS,
      AgentToolNames.GITHUB_GET_PULL_REQUEST,
      AgentToolNames.GITHUB_LIST_PR_FILES,
      AgentToolNames.GITHUB_GET_FILE_CONTENTS,
      AgentToolNames.GITHUB_SEARCH_CODE,
      AgentToolNames.GITHUB_LIST_WORKFLOW_RUNS,
      AgentToolNames.GITHUB_GET_WORKFLOW_RUN,
      AgentToolNames.GITHUB_LIST_RELEASES,
      AgentToolNames.GITHUB_GET_RELEASE,
      AgentToolNames.GITHUB_SEARCH_ISSUES,
      AgentToolNames.GITHUB_GET_ISSUE,
      AgentToolNames.LINEAR_LIST_ISSUES,
      AgentToolNames.LINEAR_GET_ISSUE,
      AgentToolNames.LINEAR_LIST_PROJECTS,
      AgentToolNames.LINEAR_GET_PROJECT,
    ],
    e2eCapable: true,
    e2eEnabledTools: [AgentToolNames.SEND_MESSAGE, AgentToolNames.WEB_SEARCH, AgentToolNames.READ_URL],
    managedBy: "system",
    status: "active",
    visibility: "visible",
  },
  [EMPTY_AGENT_ID]: {
    id: EMPTY_AGENT_ID,
    workspaceId: null,
    slug: "empty",
    name: "Empty Agent",
    description: "Locked-down internal agent shell.",
    avatarEmoji: null,
    systemPrompt: "You are a minimal Threa agent. Follow system instructions and do not use tools.",
    model: "openrouter:anthropic/claude-haiku-4.5",
    temperature: 0,
    maxTokens: null,
    enabledTools: [],
    e2eCapable: false,
    e2eEnabledTools: null,
    managedBy: "system",
    status: "active",
    visibility: "internal",
  },
} as const satisfies Record<string, BuiltInAgentConfig>

const BUILT_IN_AGENT_CONFIGS: Record<string, BuiltInAgentConfig> = BUILT_IN_AGENTS

/**
 * Return the static built-in agent config for a known `persona_system_*` id, or `null` if unknown.
 */
export function getBuiltInAgentConfig(agentId: string): BuiltInAgentConfig | null {
  return BUILT_IN_AGENT_CONFIGS[agentId] ?? null
}

/**
 * List built-in agents that are product-visible (excludes `internal` agents such as the empty shell).
 */
export function listVisibleBuiltInAgentConfigs(): BuiltInAgentConfig[] {
  return Object.values(BUILT_IN_AGENT_CONFIGS).filter((agent) => agent.visibility === "visible")
}

/**
 * Apply and validate a workspace override patch for a code-backed built-in.
 *
 * This is the only supported path to merge `agent_config_overrides.patch` into built-in defaults: it
 * validates the patch, merges with `base`, then re-parses the full config so invalid end states
 * fail loudly.
 */
export function applyBuiltInAgentPatch(
  base: BuiltInAgentConfig,
  rawPatch: unknown,
  context: { workspaceId: string; agentId: string }
): BuiltInAgentConfig {
  const patchResult = builtInAgentConfigPatchSchema.safeParse(rawPatch)
  if (!patchResult.success) {
    throw new Error(
      `Invalid agent config override for ${context.agentId} in workspace ${context.workspaceId}: ${patchResult.error.message}`
    )
  }

  const merged = { ...base, ...patchResult.data }
  return builtInAgentConfigSchema.parse(merged)
}
