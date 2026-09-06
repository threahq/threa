import { useParams } from "react-router-dom"
import type { AgentToolEffect } from "@threahq/types"
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
 * `live-session-effect-grid.tsx`, which owns that guarantee.
 */
export function SessionEffectGrid({ effects }: { effects: AgentToolEffect[] }) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const settings = useOptionalSettings()

  if (effects.length === 0) return null

  const lastSpansBoth = effects.length % 2 === 1

  return (
    <div className="effect-grid-host mt-1 px-3.5 text-[11px]">
      <div className="effect-grid gap-x-4">
        {effects.map((effect, index) => (
          <EffectRow
            key={`${effect.kind}-${effect.target ?? ""}-${index}`}
            effect={effect}
            workspaceId={workspaceId}
            getSettingsUrl={settings?.getSettingsUrl}
            variant="grid"
            // An odd count would otherwise leave a hole in the last row that
            // reads as a missing item; the tail spans instead.
            className={lastSpansBoth && index === effects.length - 1 ? "effect-grid-span" : undefined}
          />
        ))}
      </div>
    </div>
  )
}
