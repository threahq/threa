// =============================================================================
// User Statuses
//
// A user's status is a cosmetic emoji + short text shown beside their avatar
// across the app (messages, sidebar, profile). It can expire automatically.
//
// Three layers feed the status picker:
//   1. SYSTEM_DEFAULT_STATUSES — shipped fallback presets (this file).
//   2. Workspace default presets — admin-managed, overrides the system list
//      (stored on WorkspaceSettings.userStatusPresets).
//   3. Per-user custom presets — additive to the above
//      (stored on UserPreferences.statusPresets).
//
// The *active* status lives on the user row (statusEmoji/statusText/
// statusExpiresAt) so it broadcasts to the whole workspace. Presets are only
// templates the picker resolves into an active status.
// =============================================================================

/**
 * How long a status stays active, expressed as a preset descriptor rather than
 * an absolute instant so it survives being stored as a workspace/user default.
 * Mirrors the scheduling reminder presets (duration-from-now vs. calendar
 * anchor) so the picker can reuse the same resolution math. `null` (or absent)
 * on a preset means "indefinite — never auto-clear".
 */
export type StatusDuration =
  | { kind: "duration"; minutes: number }
  | { kind: "calendar"; calendar: "tomorrow-start" | "next-week-start" | "next-working-day-start" }

/**
 * A selectable status template. At least one of `emoji`/`text` must be set —
 * enforced in code (no DB constraint, INV-1/INV-3).
 *
 * `emoji` is an emoji shortcode (no surrounding colons, e.g. `"dart"`), matching
 * how personas/bots/labels store emoji; render it through the workspace emoji
 * map's `toEmoji()`. `id` is a stable key for React lists and de-duplication;
 * system presets use fixed slugs, user/workspace custom presets use ULIDs.
 */
export interface StatusPreset {
  id: string
  emoji: string | null
  text: string | null
  /** Optional default expiry applied when the preset is picked. `null` = indefinite. */
  defaultDuration: StatusDuration | null
  /**
   * When true, activating this status also pauses notification delivery for the
   * status's lifetime (until it clears or expires) — this is what turns the
   * cosmetic "Do not disturb" preset into real do-not-disturb. Optional and
   * treated as `false` when absent so presets stored before this field shipped
   * keep parsing. Read it through `presetPausesNotifications`.
   */
  pausesNotifications?: boolean
}

/** Whether a preset silences notifications, tolerant of presets stored without the field. */
export function presetPausesNotifications(preset: Pick<StatusPreset, "pausesNotifications">): boolean {
  return preset.pausesNotifications === true
}

/**
 * The resolved, currently-active status for a user, after expiry masking.
 * `expiresAt` is an ISO 8601 instant; `null` means indefinite.
 */
export interface ActiveStatus {
  emoji: string | null
  text: string | null
  expiresAt: string | null
}

/** Shape of the status columns on a user row (wire format). */
export interface UserStatusFields {
  statusEmoji: string | null
  statusText: string | null
  statusExpiresAt: string | null
}

// =============================================================================
// Notification pause (Do Not Disturb)
//
// Two independent sources can silence a user's notifications:
//   1. A *status* whose `pausesNotifications` flag is set — bounded by the
//      status's own expiry (statusExpiresAt). Setting the "Do not disturb"
//      preset is the canonical example, but the picker lets any status pause.
//   2. A *manual* pause the user sets without touching their status — "pause
//      for an hour" or "pause until I turn it back on". Survives status changes.
//
// Both self-expire, so the effective "are notifications paused right now?" is a
// pure function of the user row + the current instant — no combining writes and
// no clearing races. `resolveNotificationPause` is that function, shared by the
// backend push gate and the frontend badge/settings so the rule has exactly one
// definition (INV-35).
// =============================================================================

/** Manual notification-pause columns on a user row (wire format). */
export interface UserNotificationPauseFields {
  /** Whether the active status silences notifications for its lifetime. */
  statusPausesNotifications: boolean
  /** ISO 8601 instant the manual pause ends, or null when not on a timed pause. */
  notificationsPausedUntil: string | null
  /** True when the user paused with no end ("until I turn it back on"). */
  notificationsPausedIndefinitely: boolean
}

/** What is currently silencing a user's notifications. */
export type NotificationPauseSource = "status" | "manual" | "both"

/** The resolved, currently-active notification pause, after expiry masking. */
export interface ActiveNotificationPause {
  /** ISO 8601 instant the pause ends; `null` means indefinite. */
  until: string | null
  source: NotificationPauseSource
}

function laterInstantOrIndefinite(a: string | null, b: string | null): string | null {
  // A null end means "indefinite", which always outlasts any concrete instant.
  if (a === null || b === null) return null
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}

/**
 * Resolve a user's status + manual-pause fields into an active notification
 * pause, or `null` when notifications are flowing. Callers pass `now` so the
 * same instant can drive a render pass or a single delivery decision.
 *
 * The status branch reuses `resolveActiveStatus`, so an expired DND status stops
 * silencing automatically; the manual branch masks its own elapsed `until`.
 */
export function resolveNotificationPause(
  fields: UserStatusFields & UserNotificationPauseFields,
  now: Date = new Date()
): ActiveNotificationPause | null {
  const status = resolveActiveStatus(fields, now)
  const statusPauses = status !== null && fields.statusPausesNotifications
  const statusUntil = statusPauses ? status!.expiresAt : null

  const manualActive =
    fields.notificationsPausedIndefinitely ||
    (fields.notificationsPausedUntil !== null && new Date(fields.notificationsPausedUntil).getTime() > now.getTime())
  const manualUntil = fields.notificationsPausedIndefinitely
    ? null
    : manualActive
      ? fields.notificationsPausedUntil
      : null

  if (!statusPauses && !manualActive) return null
  if (statusPauses && manualActive) {
    return { until: laterInstantOrIndefinite(statusUntil, manualUntil), source: "both" }
  }
  if (statusPauses) return { until: statusUntil, source: "status" }
  return { until: manualUntil, source: "manual" }
}

/** A preset is valid only if it carries an emoji, text, or both. */
export function isStatusContentful(value: { emoji: string | null; text: string | null }): boolean {
  return Boolean((value.emoji && value.emoji.length > 0) || (value.text && value.text.trim().length > 0))
}

/**
 * Resolve a user's stored status fields into an active status, masking ones
 * that have expired or carry no content. Returns `null` when there is nothing
 * to show. Callers pass `now` so the same instant can drive a render pass.
 */
export function resolveActiveStatus(fields: UserStatusFields, now: Date = new Date()): ActiveStatus | null {
  if (!isStatusContentful({ emoji: fields.statusEmoji, text: fields.statusText })) return null
  if (fields.statusExpiresAt && new Date(fields.statusExpiresAt).getTime() <= now.getTime()) return null
  return {
    emoji: fields.statusEmoji,
    text: fields.statusText,
    expiresAt: fields.statusExpiresAt,
  }
}

/**
 * Built-in status presets, used when a workspace has not configured its own.
 * Durations reuse the scheduling presets: "tomorrow-start" resolves to the
 * start of the next working day (09:00 on the default Mon–Fri schedule), which
 * is the "until tomorrow 09:00" the product spec calls for.
 */
export const SYSTEM_DEFAULT_STATUSES: StatusPreset[] = [
  { id: "focus", emoji: "dart", text: "Focus mode", defaultDuration: { kind: "duration", minutes: 60 } },
  { id: "out-and-about", emoji: "walking", text: "Out and about", defaultDuration: { kind: "duration", minutes: 240 } },
  {
    id: "out-of-office",
    emoji: "palm_tree",
    text: "Out of office",
    defaultDuration: { kind: "calendar", calendar: "tomorrow-start" },
  },
  {
    id: "sick",
    emoji: "face_with_thermometer",
    text: "Sick",
    defaultDuration: { kind: "calendar", calendar: "next-working-day-start" },
  },
  { id: "do-not-disturb", emoji: "no_bell", text: "Do not disturb", defaultDuration: null, pausesNotifications: true },
  { id: "vab", emoji: "teddy_bear", text: "VAB", defaultDuration: null },
]

/** Bounds for status text length, shared by client validation and Zod schemas. */
export const STATUS_TEXT_MAX_LENGTH = 100
/** Cap on how many custom presets a user or workspace may store. */
export const MAX_STATUS_PRESETS = 25
