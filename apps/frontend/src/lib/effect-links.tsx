import type { ReactNode } from "react"
import {
  AGENT_SETTABLE_PREFERENCE_KEYS,
  EFFECTS_PER_SESSION_MAX,
  type AgentSettablePreferenceKey,
  type AgentToolEffect,
  type SettingsTab,
  type ToolEffectKind,
} from "@threa/types"
import { Clock, FileText, PenLine, SlidersHorizontal, Sparkles, TerminalSquare, type LucideIcon } from "lucide-react"
import { buildDelegationPath } from "@/lib/stream-links"
import { cn } from "@/lib/utils"

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

/**
 * The glyph that tells one kind of write from another at a glance. Without it
 * every row reads as the same sort of thing, which is most of what makes a
 * dense list scannable rather than a wall of grey text.
 */
const EFFECT_KIND_ICONS = {
  settings: SlidersHorizontal,
  delegation: TerminalSquare,
  memo: Sparkles,
  follow_up: Clock,
  brief: FileText,
  other: PenLine,
} as const satisfies Record<ToolEffectKind, LucideIcon>

export function kindIcon(kind: ToolEffectKind): LucideIcon {
  return EFFECT_KIND_ICONS[kind] ?? EFFECT_KIND_ICONS.other
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
  delegation: (target, workspaceId) => buildDelegationPath(workspaceId, encodeURIComponent(target)),
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

/**
 * The change to draw, when there is one. `before` is optional: a reschedule
 * knows where it landed but not where it started, and `→ Thu 9:00` still tells
 * the user the thing moved. Dropping it would render a moved reminder exactly
 * like an untouched one.
 */
export function effectDiff(effect: AgentToolEffect): { before?: string; after: string } | null {
  if (effect.after === undefined) return null
  return { ...(effect.before !== undefined ? { before: effect.before } : {}), after: effect.after }
}

/**
 * Union of a session's effects across its payloads, deduped and in emission
 * order. A retry's `upsertStep` resets the step row's effects, so each
 * attempt's `interrupted` payload is the only surviving record of what that
 * attempt wrote — dropping any of them would make a real write invisible.
 *
 * Capped because the caller spreads one payload per retry attempt: the backend
 * bounds each payload on its own, but their union is not bounded by anything
 * else.
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
  return out.slice(0, EFFECTS_PER_SESSION_MAX)
}

/**
 * One effect's row content, shared by the trace step list and the in-stream
 * grid so the two cannot drift (INV-35) — they had drifted into byte-identical
 * copies once already.
 *
 * The label is capped ONLY when a diff shares the row. Capping unconditionally
 * left a label-only row truncated at 55% with the rest of the row empty, which
 * is how a rescheduled follow-up lost its own note.
 */
export function EffectRowContent({ effect, trailing }: { effect: AgentToolEffect; trailing?: ReactNode }) {
  const diff = effectDiff(effect)
  const Icon = kindIcon(effect.kind)
  return (
    <>
      <Icon aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
      <span className={cn("truncate", diff ? "max-w-[55%] shrink-0" : "min-w-0")}>{effectLabel(effect)}</span>
      {diff && (
        <span className="min-w-0 truncate text-muted-foreground/70">
          {diff.before !== undefined && `${diff.before} `}→ {diff.after}
        </span>
      )}
      {trailing}
    </>
  )
}
