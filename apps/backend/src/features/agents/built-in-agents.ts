import { z } from "zod"
import {
  AgentToolNames,
  personaConfigPatchSchema,
  personaConfigStatusSchema,
  personaResolvedConfigSchema,
} from "@threahq/types"

export const ARIADNE_AGENT_ID = "persona_system_ariadne"
export const EMPTY_AGENT_ID = "persona_system_empty"

// The full built-in agent config shape is single-sourced in `@threahq/types`
// (INV-31) so the wire type (`PersonaResolvedConfig`) and this backend type
// cannot drift. `escalationModel` is the stronger model for per-turn escalation
// (roadmap 2.3, documented in docs/model-reference.md per INV-16); `e2eCapable`
// gates whether the enclave may run the persona inside an E2E scratchpad.
export const builtInAgentConfigSchema = personaResolvedConfigSchema

// The internal override-resolution schema: the shared editable-field patch
// (INV-31, one definition) plus `status`, which the API surface withholds but
// stored overrides may carry (e.g. a workspace disabling Ariadne). It does NOT
// enforce the model allowlist — that gate is registry-derived and lives in
// PersonaConfigService (INV-16); resolution must accept whatever is already
// stored, including built-in default models.
export const builtInAgentConfigPatchSchema = personaConfigPatchSchema
  .extend({ status: personaConfigStatusSchema.optional() })
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
    avatarUrl: null,
    systemPrompt: `You are Ariadne, an AI thinking companion in Threa. You help users explore ideas, think through problems, and make decisions. You have access to their previous conversations and knowledge base through the GAM (General Agentic Memory) system.

Keep responses short and direct. Default to a few sentences unless the user asks for depth. Be warm but not wordy — say what matters and stop. Ask clarifying questions rather than guessing at length.`,
    model: "openrouter:openai/gpt-5.6-luna",
    escalationModel: "openrouter:openai/gpt-5.6-terra",
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
      AgentToolNames.START_SUBAGENT,
      AgentToolNames.SAVE_MEMO,
      AgentToolNames.UPDATE_USER_SETTINGS,
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
    // Style slots unset = today's default `## Response Style` guidance (no
    // fragment). An admin sets a preset to shift tone/brevity; the free-text
    // slots stay null for built-ins (customs use them instead).
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
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
    avatarUrl: null,
    systemPrompt: "You are a minimal Threa agent. Follow system instructions and do not use tools.",
    model: "openrouter:openai/gpt-5.6-luna",
    escalationModel: null,
    temperature: 0,
    maxTokens: null,
    enabledTools: [],
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
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
 * Return the built-in config for `agentId` only if it is product-visible, else
 * `null`. The persona editor gates every read/write on this: an unknown id or an
 * internal-only shell (e.g. `EMPTY_AGENT_ID`) is a 404, never editable.
 */
export function getVisibleBuiltInAgentConfig(agentId: string): BuiltInAgentConfig | null {
  const config = BUILT_IN_AGENT_CONFIGS[agentId]
  return config && config.visibility === "visible" ? config : null
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
