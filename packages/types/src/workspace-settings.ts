// Workspace Settings: workspace-scoped configuration owned by admins. Currently the
// default working schedule that every member inherits unless they set a personal
// override. Stored sparsely (only non-default keys persisted) like user preferences.

import { type WorkSchedule, DEFAULT_WORK_SCHEDULE } from "./work-schedule"
import { type StatusPreset, SYSTEM_DEFAULT_STATUSES } from "./user-status"

/**
 * Code default for the per-stream pending-follow-up cap (roadmap 1.1/1.4). The
 * single source of truth for the number: `DEFAULT_WORKSPACE_SETTINGS` seeds the
 * workspace-tunable setting from it, and the backend re-exports it from
 * `agents/config.ts` so the follow-up service resolver still imports the name it
 * always has (INV-33 — one number, not two that can drift).
 */
export const DEFAULT_MAX_PENDING_FOLLOW_UPS = 10
/** Bounds on the workspace-tunable follow-up cap, shared by the API validator and the settings input. */
export const MAX_PENDING_FOLLOW_UPS_MIN = 1
export const MAX_PENDING_FOLLOW_UPS_MAX = 100

/**
 * Price banding for a delegable model. `premium` is the "you are paying real
 * money for this second opinion" band — the admin picker marks those opt-in and
 * ships them off by default.
 */
export const SUBAGENT_MODEL_TIERS = ["standard", "premium"] as const
export type SubagentModelTier = (typeof SUBAGENT_MODEL_TIERS)[number]

/**
 * One model an admin may put in the workspace's delegable set, with what it
 * costs. Prices are USD per 1M tokens from the `docs/model-reference.md` price
 * table — the registry (`models.yaml`) carries capabilities, not rates, so the
 * number a picker shows has to come from somewhere and this is the one place it
 * does (INV-33). The backend still sends only ids (INV-46); the label and the
 * rate are formatted client-side from here.
 *
 * Rates verified against the `docs/model-reference.md` price table on
 * 2026-09-01. They are DISPLAY-ONLY — nothing bills off them — so a stale figure
 * misinforms an admin but cannot mischarge anyone.
 */
export interface SubagentModelCatalogEntry {
  id: string
  label: string
  tier: SubagentModelTier
  /** USD per 1M input tokens. */
  inputPricePerMTok: number
  /** USD per 1M output tokens. */
  outputPricePerMTok: number
  /** Whether a workspace that never touched the setting delegates to this model. */
  defaultEnabled: boolean
}

/**
 * The models offered as delegation targets. A curated subset of the registry —
 * a subagent is a second opinion, so the list is the models worth asking, not
 * every chat model that exists. `apps/backend/src/features/subagents/models.test.ts`
 * holds every id here to being a registry chat model, and the settings write path
 * re-checks against the registry, so an entry can never become an offer the
 * runtime refuses.
 */
export const SUBAGENT_MODEL_CATALOG: readonly SubagentModelCatalogEntry[] = [
  {
    id: "openrouter:openai/gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    tier: "standard",
    inputPricePerMTok: 2.5,
    outputPricePerMTok: 15,
    defaultEnabled: true,
  },
  {
    id: "openrouter:anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    tier: "standard",
    inputPricePerMTok: 2,
    outputPricePerMTok: 10,
    defaultEnabled: true,
  },
  {
    id: "openrouter:google/gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    tier: "standard",
    inputPricePerMTok: 1.5,
    outputPricePerMTok: 7.5,
    defaultEnabled: false,
  },
  {
    id: "openrouter:openai/gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    tier: "standard",
    inputPricePerMTok: 0.2,
    outputPricePerMTok: 1.2,
    defaultEnabled: false,
  },
  {
    id: "openrouter:anthropic/claude-opus-5",
    label: "Claude Opus 5",
    tier: "premium",
    inputPricePerMTok: 5,
    outputPricePerMTok: 25,
    defaultEnabled: false,
  },
  {
    id: "openrouter:openai/gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    tier: "premium",
    inputPricePerMTok: 5,
    outputPricePerMTok: 30,
    defaultEnabled: false,
  },
] as const

/**
 * The delegable model set a workspace starts with. Terra and Sonnet 5 are the
 * two current-gen models worth a second opinion at a price a default can carry;
 * Opus/Sol tiers are opt-in per workspace rather than on by default.
 */
export const DEFAULT_SUBAGENT_MODELS: string[] = SUBAGENT_MODEL_CATALOG.filter((entry) => entry.defaultEnabled).map(
  (entry) => entry.id
)

/** Full workspace settings (wire format). */
export interface WorkspaceSettings {
  workspaceId: string
  /**
   * The workspace-wide default working week + hours. Members inherit this when
   * they have no personal `workSchedule` override. Falls back to Mon–Fri 09:00.
   */
  defaultWorkSchedule: WorkSchedule
  /**
   * The status presets offered to members in the status picker. Defaults to the
   * system presets; admins replace the whole list. Per-user custom presets are
   * additive on top of this (UserPreferences.statusPresets).
   */
  userStatusPresets: StatusPreset[]
  /**
   * Canonical language for extracted memos (a language name or BCP-47 tag, e.g.
   * "English" / "sv"). When set, every memo is written in this one language
   * regardless of the conversation's language, so a bilingual workspace doesn't
   * store the same knowledge twice (and embedding dedup, which aligns weakly
   * across languages, stays reliable). `null` lets each memo follow its
   * conversation's language; the backend then defaults to the participants'
   * primary language.
   */
  memoLanguage: string | null
  /**
   * Shared dictation steering words (product names, people, domain jargon) the
   * voice pipeline biases toward for every member. Unioned at session start with
   * the baked-in product terms and each member's personal `voiceSteeringWords`.
   * Admin-managed. Empty by default.
   */
  voiceSteeringWords: string[]
  /**
   * Cap on the number of pending follow-ups the assistant may hold per stream
   * (roadmap 1.4). Resolves `workspace override ?? DEFAULT_MAX_PENDING_FOLLOW_UPS`
   * in the follow-up service; a per-stream column is deferred until asked for.
   */
  maxPendingFollowUps: number
  /**
   * The workspace-wide default companion persona a scratchpad runs when it has no
   * explicit persona pick. Resolution order is user preference
   * (`UserPreferences.defaultCompanionPersonaId`) → this workspace setting →
   * built-in Ariadne. `null` means Ariadne. A stored id that is missing, archived,
   * or not active in the workspace degrades to the next tier at dispatch time;
   * write-time validation rejects an id that isn't an active persona here.
   */
  defaultCompanionPersonaId: string | null
  /**
   * The workspace's own IANA timezone: the boundary its AI spend month is cut
   * on. Anchors both halves of the budget — `budget-service.checkBudget` resolves
   * the enforcement window against it (so degradation and the hard limit reset on
   * the workspace's midnight, not the server's), and the AI usage dashboard
   * offers it as a reporting zone alongside the viewer's device zone.
   *
   * Storage stays UTC timestamps (`ai_usage_records.created_at`); this only moves
   * where the month is cut. Defaults to "UTC" rather than a member's zone — a
   * shared money boundary has to be a deliberate choice, not one member's laptop.
   */
  billingTimezone: string
  /**
   * The models a persona may delegate a subagent to (`start_subagent`). Each
   * entry is a registry model id (`provider:model`); the tool validates against
   * the registry first, then this set, so an id that leaves `models.yaml` stops
   * being delegable without a settings migration. Expensive tiers are opt-in:
   * the default carries one strong reasoning model and one strong generalist,
   * and an admin adds the rest deliberately.
   */
  subagentModels: string[]
  createdAt: string
  updatedAt: string
}

/** Defaults applied when a workspace has stored no overrides. */
export const DEFAULT_WORKSPACE_SETTINGS: Omit<WorkspaceSettings, "workspaceId" | "createdAt" | "updatedAt"> = {
  defaultWorkSchedule: DEFAULT_WORK_SCHEDULE,
  userStatusPresets: SYSTEM_DEFAULT_STATUSES,
  memoLanguage: null,
  voiceSteeringWords: [],
  maxPendingFollowUps: DEFAULT_MAX_PENDING_FOLLOW_UPS,
  defaultCompanionPersonaId: null,
  billingTimezone: "UTC",
  subagentModels: DEFAULT_SUBAGENT_MODELS,
}

/** Partial update — only provided fields are changed. */
export interface UpdateWorkspaceSettingsInput {
  defaultWorkSchedule?: WorkSchedule
  userStatusPresets?: StatusPreset[]
  memoLanguage?: string | null
  voiceSteeringWords?: string[]
  maxPendingFollowUps?: number
  defaultCompanionPersonaId?: string | null
  billingTimezone?: string
  subagentModels?: string[]
}

/** Valid top-level settings keys that can be overridden. */
export type WorkspaceSettingKey = keyof Omit<WorkspaceSettings, "workspaceId" | "createdAt" | "updatedAt">
