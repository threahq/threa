import { Link, useParams } from "react-router-dom"
import type { AgentToolEffect } from "@threa/types"
import { useOptionalSettings } from "@/contexts"
import { effectDiff, effectLabel, kindIcon, resolveEffectPath } from "@/lib/effect-links"
import { cn } from "@/lib/utils"

/**
 * What a finished turn wrote, one line per effect, under the session card.
 *
 * Rendered as a SIBLING of the card's `<Link>`, never inside it: the card is an
 * `<a>`, and a nested `<a>` is invalid HTML and a screen-reader trap. That
 * placement is the whole reason the lines can be links at all.
 *
 * The caller only passes effects for terminal sessions, so the grid appears as
 * part of the same status transition that already swaps the card's title, icon
 * and colours — nothing pops in mid-turn (INV-21).
 */
export function SessionEffectGrid({ effects }: { effects: AgentToolEffect[] }) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const settings = useOptionalSettings()

  if (effects.length === 0) return null

  const lastSpansBoth = effects.length % 2 === 1

  return (
    <div className="mt-1 grid grid-cols-1 gap-x-4 px-3.5 text-[11px] sm:grid-cols-2">
      {effects.map((effect, index) => {
        const path = resolveEffectPath(effect, { workspaceId, getSettingsUrl: settings?.getSettingsUrl })
        // An odd count would otherwise leave a hole in the last row that reads
        // as a missing item; the tail spans instead.
        const spanClass = lastSpansBoth && index === effects.length - 1 ? "sm:col-span-2" : undefined
        return (
          <EffectLine
            key={`${effect.kind}-${effect.target ?? ""}-${index}`}
            effect={effect}
            path={path}
            className={spanClass}
          />
        )
      })}
    </div>
  )
}

function EffectLine({ effect, path, className }: { effect: AgentToolEffect; path: string | null; className?: string }) {
  const body = <EffectLineBody effect={effect} hasRoute={path !== null} />

  // No route means no destination — a greyed, non-focusable span, never a link
  // with nowhere to go. Follow-ups and briefs have no route anywhere in the app.
  if (!path) {
    return (
      <span className={cn("flex min-w-0 items-center gap-1.5 py-[3px] text-muted-foreground/60", className)}>
        {body}
      </span>
    )
  }

  return (
    <Link
      to={path}
      className={cn(
        "flex min-w-0 items-center gap-1.5 py-[3px] text-muted-foreground no-underline transition-colors hover:text-primary",
        className
      )}
    >
      {body}
    </Link>
  )
}

function EffectLineBody({ effect, hasRoute }: { effect: AgentToolEffect; hasRoute: boolean }) {
  const diff = effectDiff(effect)
  const Icon = kindIcon(effect.kind)
  return (
    <>
      <Icon aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
      <span className="min-w-0 truncate">{effectLabel(effect)}</span>
      {diff && (
        <span className="min-w-0 shrink truncate text-muted-foreground/70">
          {diff.before} → {diff.after}
        </span>
      )}
      {hasRoute && (
        <span aria-hidden className="ml-auto shrink-0 text-muted-foreground/50">
          ›
        </span>
      )}
    </>
  )
}
