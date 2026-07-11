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
  // Stronger model for per-turn escalation (roadmap 2.3): a supersede rerun
  // whose previous attempt failed the response validator runs on this instead
  // of `model`. Null disables escalation. Must be documented in
  // docs/model-reference.md (INV-16).
  escalationModel: z.string().min(1).nullable(),
  temperature: z.number().nullable(),
  maxTokens: z.number().int().positive().nullable(),
  enabledTools: z.array(agentToolNameSchema),
  managedBy: z.literal("system"),
  status: agentStatusSchema,
  visibility: agentVisibilitySchema,
  // Whether this persona may run inside an E2E scratchpad — served by the
  // enclave, which decrypts in isolation. Only e2e-capable personas can be the
  // enclave actor; the dispatch path refuses to forward to a non-capable one.
  e2eCapable: z.boolean(),
})

export const builtInAgentConfigPatchSchema = builtInAgentConfigSchema
  .pick({
    name: true,
    description: true,
    avatarEmoji: true,
    systemPrompt: true,
    model: true,
    escalationModel: true,
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
    model: "openrouter:anthropic/claude-sonnet-5",
    escalationModel: "openrouter:anthropic/claude-opus-4.8",
    temperature: 0.7,
    maxTokens: null,
    enabledTools: [
      AgentToolNames.SEND_MESSAGE,
      AgentToolNames.WEB_SEARCH,
      AgentToolNames.READ_URL,
      AgentToolNames.GENERAL_RESEARCH,
      AgentToolNames.DESCRIBE_MEMO,
      AgentToolNames.REACT_TO_MESSAGE,
      AgentToolNames.SCHEDULE_FOLLOW_UP,
      AgentToolNames.LIST_FOLLOW_UPS,
      AgentToolNames.CANCEL_FOLLOW_UP,
      AgentToolNames.UPDATE_FOLLOW_UP,
      AgentToolNames.UPDATE_STREAM_BRIEF,
      AgentToolNames.DELEGATE_TASK,
      AgentToolNames.SAVE_MEMO,
      AgentToolNames.SEARCH_ATTACHMENTS,
      AgentToolNames.READ_ATTACHMENT,
      AgentToolNames.GITHUB_REPOS,
      AgentToolNames.GITHUB_COMMITS,
      AgentToolNames.GITHUB_PULLS,
      AgentToolNames.GITHUB_CONTENT,
      AgentToolNames.GITHUB_WORKFLOWS,
      AgentToolNames.GITHUB_RELEASES,
      AgentToolNames.GITHUB_ISSUES,
      AgentToolNames.LINEAR_LIST_ISSUES,
      AgentToolNames.LINEAR_GET_ISSUE,
      AgentToolNames.LINEAR_LIST_PROJECTS,
      AgentToolNames.LINEAR_GET_PROJECT,
    ],
    managedBy: "system",
    status: "active",
    visibility: "visible",
    e2eCapable: true,
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
    escalationModel: null,
    temperature: 0,
    maxTokens: null,
    enabledTools: [],
    managedBy: "system",
    status: "active",
    visibility: "internal",
    e2eCapable: false,
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
 * Whether the persona behind `agentId` may serve an E2E scratchpad. Only
 * built-in personas can today (the enclave runs Ariadne); a non-built-in or
 * unknown id is never e2e-capable. Used by the enclave invite/dispatch gate.
 */
export function isE2eCapablePersona(agentId: string): boolean {
  return BUILT_IN_AGENT_CONFIGS[agentId]?.e2eCapable === true
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
