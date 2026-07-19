import { PhoneCall } from "lucide-react"

/**
 * Shown when the call's Web Lock is held by another tab (`store.activeElsewhere`):
 * this tab isn't in the call, so it offers only a compact status marker. Rejoin
 * lands in a later PR (ring/rejoin bar) — this is the read-only signal.
 */
export function ActiveElsewhereChip() {
  return (
    <div className="flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-lg">
      <PhoneCall className="h-3.5 w-3.5" aria-hidden />
      Call active in another tab
    </div>
  )
}
