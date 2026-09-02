import { useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import {
  AGENT_SETTABLE_PREFERENCE_KEYS,
  EFFECTS_PER_SESSION_MAX,
  type AgentSettablePreferenceKey,
  type AgentToolEffect,
  type SettingsTab,
  type ToolEffectKind,
} from "@threa/types"
import {
  Bot,
  Clock,
  FileText,
  PenLine,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react"
import { buildDelegationPath } from "@/lib/stream-links"
import { cn } from "@/lib/utils"
import { MemoPreviewDialog } from "@/components/memo/memo-preview-dialog"

/** How a label-less effect names itself. The backend sends no display text (INV-46). */
const EFFECT_KIND_NOUNS = {
  settings: "Setting",
  delegation: "Delegation",
  memo: "Memo",
  follow_up: "Follow-up",
  brief: "Brief",
  subagent: "Subagent",
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
  subagent: Bot,
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
 *
 * A memo has no route either: it opens in place, in `MemoPreviewDialog`, so
 * reading it never navigates away from the conversation that produced it.
 */
const EFFECT_ROUTE_RESOLVERS = {
  memo: () => null,
  delegation: (target, workspaceId) => buildDelegationPath(workspaceId, encodeURIComponent(target)),
  settings: (target, _workspaceId, ctx) => {
    const tab = settingsTabFor(target)
    if (!tab || !ctx.getSettingsUrl) return null
    return ctx.getSettingsUrl(tab)
  },
  follow_up: () => null,
  brief: () => null,
  // Routeless: the effect's target is the run id, which names no route — the
  // destination thread is known only to the card event's own payload.
  subagent: () => null,
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
 * Whether an effect has anything to say. A layer-0 marker is a bare `{ kind }`
 * — a mutating tool declared nothing, so there is nothing to name, diff or
 * link and it only earns a counter on the meta line.
 */
export function isDescribedEffect(effect: AgentToolEffect): boolean {
  return (
    effect.label !== undefined ||
    effect.target !== undefined ||
    effect.before !== undefined ||
    effect.after !== undefined
  )
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

/**
 * Per-surface styling for a row. The affordance logic below is shared; only
 * these class names differ between the in-stream grid and the trace step list,
 * so the two cannot drift again (INV-29, INV-35).
 */
const EFFECT_ROW_VARIANTS = {
  grid: {
    interactive:
      "flex min-w-0 items-center gap-1.5 py-[3px] text-left text-muted-foreground no-underline transition-colors hover:text-primary",
    inert: "flex min-w-0 items-center gap-1.5 py-[3px] text-muted-foreground/60",
    chevron: "ml-auto shrink-0 text-muted-foreground/50",
  },
  list: {
    interactive: "flex min-w-0 items-center gap-1.5 text-left text-primary hover:underline",
    inert: "flex min-w-0 items-center gap-1.5 text-muted-foreground",
    chevron: "shrink-0 text-muted-foreground/60",
  },
} as const

export type EffectRowVariant = keyof typeof EFFECT_ROW_VARIANTS

/**
 * One effect's row, affordance included — the single place that decides
 * between a dialog button, a link, and inert text.
 *
 * A memo opens IN PLACE (`MemoPreviewDialog`), never as navigation to the
 * memory explorer: the same rule `memo-captured-event.tsx` follows, because
 * being thrown out of the conversation to read what was just saved is what
 * made the explorer route wrong. Everything with a resolvable path is a
 * `<Link>` (INV-40); everything else is a non-focusable span.
 */
export function EffectRow({
  effect,
  workspaceId,
  getSettingsUrl,
  variant,
  className,
}: {
  effect: AgentToolEffect
  workspaceId: string | null | undefined
  getSettingsUrl?: (tab?: SettingsTab) => string
  variant: EffectRowVariant
  className?: string
}) {
  const [memoOpen, setMemoOpen] = useState(false)
  const styles = EFFECT_ROW_VARIANTS[variant]
  const chevron = (
    <span aria-hidden className={styles.chevron}>
      ›
    </span>
  )

  if (effect.kind === "memo" && effect.target && workspaceId) {
    return (
      <>
        <button
          type="button"
          onClick={() => setMemoOpen(true)}
          aria-haspopup="dialog"
          className={cn(styles.interactive, className)}
        >
          <EffectRowContent effect={effect} trailing={chevron} />
        </button>
        <MemoPreviewDialog
          open={memoOpen}
          onOpenChange={setMemoOpen}
          workspaceId={workspaceId}
          memoId={effect.target}
          fallbackTitle={effectLabel(effect)}
        />
      </>
    )
  }

  const path = resolveEffectPath(effect, { workspaceId, getSettingsUrl })
  if (!path) {
    return (
      <span className={cn(styles.inert, className)}>
        <EffectRowContent effect={effect} />
      </span>
    )
  }

  return (
    <Link to={path} className={cn(styles.interactive, className)}>
      <EffectRowContent effect={effect} trailing={chevron} />
    </Link>
  )
}
