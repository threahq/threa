import { useParams } from "react-router-dom"
import type { AgentToolEffect } from "@threa/types"
import { PenLine } from "lucide-react"
import { useOptionalSettings } from "@/contexts"
import { EffectRow } from "@/lib/effect-links"

/**
 * What a turn wrote, one line per effect, under the session card.
 *
 * Rendered as a SIBLING of the card's `<Link>`, never inside it: the card is an
 * `<a>`, and a nested interactive element inside it is invalid HTML and a
 * screen-reader trap. That placement is the whole reason the lines can be links
 * and dialog buttons at all.
 *
 * Rows only ever append while a turn is in flight (INV-21) — see
 * `live-session-effect-list.tsx`, which owns that guarantee.
 */
export function SessionEffectList({ effects }: { effects: AgentToolEffect[] }) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const settings = useOptionalSettings()

  if (effects.length === 0) return null

  return (
    <section className="mt-2 px-3.5 text-[11px]" aria-label="Changes made">
      <div className="flex items-center gap-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <PenLine aria-hidden className="h-3 w-3" />
        Changes made
      </div>
      <ul aria-label="Changes made" className="divide-y divide-border/70 border-y border-border/70">
        {effects.map((effect, index) => (
          <li key={`${effect.kind}-${effect.target ?? ""}-${index}`}>
            <EffectRow
              effect={effect}
              workspaceId={workspaceId}
              getSettingsUrl={settings?.getSettingsUrl}
              variant="session"
            />
          </li>
        ))}
      </ul>
    </section>
  )
}
