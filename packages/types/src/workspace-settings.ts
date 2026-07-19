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
   * Feature flag for voice/video calls (dark feature, default OFF). Off ⇒ the
   * calls HTTP/socket surfaces answer as if the feature does not exist
   * (`CALLS_DISABLED`, 404-style) per the house convention for gated features.
   * Flipped on per-workspace during rollout; the M1 exit gate requires the
   * Cloudflare DPA/processor-register entry before enabling it in prod.
   */
  callsEnabled: boolean
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
  callsEnabled: false,
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
  callsEnabled?: boolean
}

/** Valid top-level settings keys that can be overridden. */
export type WorkspaceSettingKey = keyof Omit<WorkspaceSettings, "workspaceId" | "createdAt" | "updatedAt">
