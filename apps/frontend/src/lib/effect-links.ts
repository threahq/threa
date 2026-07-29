import {
  AGENT_SETTABLE_PREFERENCE_KEYS,
  type AgentSettablePreferenceKey,
  type AgentToolEffect,
  type SettingsTab,
  type ToolEffectKind,
} from "@threa/types"
import { buildDelegationPath } from "@/lib/stream-links"

/** How a label-less effect names itself. The backend sends no display text (INV-46). */
const EFFECT_KIND_NOUNS = {
  settings: "Setting",
  delegation: "Delegation",
  memo: "Memo",
  follow_up: "Follow-up",
  brief: "Brief",
  other: "Change",
} as const satisfies Record<ToolEffectKind, string>

export function kindNoun(kind: ToolEffectKind): string {
  return EFFECT_KIND_NOUNS[kind] ?? EFFECT_KIND_NOUNS.other
}

export function effectLabel(effect: AgentToolEffect): string {
  return effect.label ?? kindNoun(effect.kind)
}

/**
 * Which settings tab edits a given agent-settable preference. Verified against
 * the tab components themselves, not inferred from the key's name.
 *
 * `language` is null on purpose: no settings tab renders it, so a link would
 * land the user on a screen that cannot show what changed.
 */
export const SETTINGS_TAB_BY_PREFERENCE_KEY = {
  theme: "appearance",
  messageDisplay: "appearance",
  unreadOpenPosition: "appearance",
  dateFormat: "datetime",
  timeFormat: "datetime",
  timezone: "datetime",
  notificationLevel: "notifications",
  workSchedule: "schedule",
  language: null,
} as const satisfies Record<AgentSettablePreferenceKey, SettingsTab | null>

function settingsTabFor(target: string): SettingsTab | null {
  if (!AGENT_SETTABLE_PREFERENCE_KEYS.includes(target as AgentSettablePreferenceKey)) return null
  return SETTINGS_TAB_BY_PREFERENCE_KEY[target as AgentSettablePreferenceKey]
}

export interface EffectRouteContext {
  workspaceId: string | null | undefined
  /**
   * `useSettings().getSettingsUrl` — settings live in a query param merged onto
   * the viewer's current URL, so the href can only be built where the router is.
   * Absent outside the workspace shell, which makes settings effects inert.
   */
  getSettingsUrl?: (tab?: SettingsTab) => string
}

type EffectResolver = (target: string, workspaceId: string, ctx: EffectRouteContext) => string | null

/**
 * Exhaustive over `ToolEffectKind` so a new kind cannot ship without an answer.
 * `null` is a legitimate answer — a routeless effect renders inert rather than
 * as a dead link. Follow-ups and briefs have no route anywhere in the app.
 */
const EFFECT_ROUTE_RESOLVERS = {
  memo: (target, workspaceId) => `/w/${workspaceId}/memory?memo=${encodeURIComponent(target)}`,
  delegation: (target, workspaceId) => buildDelegationPath(workspaceId, target),
  settings: (target, _workspaceId, ctx) => {
    const tab = settingsTabFor(target)
    if (!tab || !ctx.getSettingsUrl) return null
    return ctx.getSettingsUrl(tab)
  },
  follow_up: () => null,
  brief: () => null,
  other: () => null,
} as const satisfies Record<ToolEffectKind, EffectResolver>

/** The in-app path an effect points at, or null when it points nowhere. */
export function resolveEffectPath(effect: AgentToolEffect, ctx: EffectRouteContext): string | null {
  if (!effect.target || !ctx.workspaceId) return null
  const resolver = EFFECT_ROUTE_RESOLVERS[effect.kind]
  if (!resolver) return null
  return resolver(effect.target, ctx.workspaceId, ctx)
}

/** Both sides of a replacement, when the effect carries both. */
export function effectDiff(effect: AgentToolEffect): { before: string; after: string } | null {
  if (effect.before === undefined || effect.after === undefined) return null
  return { before: effect.before, after: effect.after }
}

/**
 * Union of a session's effects across its payloads, deduped and in emission
 * order. A retry's `upsertStep` resets the step row's effects, so the
 * `interrupted` payload is the only surviving record of the failed attempt's
 * writes — dropping it would make a real write invisible.
 */
export function unionSessionEffects(
  ...payloads: Array<{ effects?: AgentToolEffect[] } | null | undefined>
): AgentToolEffect[] {
  const seen = new Set<string>()
  const out: AgentToolEffect[] = []
  for (const payload of payloads) {
    // Dedupe only ACROSS payloads. Two identical layer-0 descriptors inside one
    // payload are two separate writes, and collapsing them would undercount.
    const added: string[] = []
    for (const effect of payload?.effects ?? []) {
      const key = JSON.stringify([effect.kind, effect.label, effect.target, effect.before, effect.after])
      if (seen.has(key)) continue
      added.push(key)
      out.push(effect)
    }
    for (const key of added) seen.add(key)
  }
  return out
}
