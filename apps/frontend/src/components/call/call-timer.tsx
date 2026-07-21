import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

/** mm:ss, or h:mm:ss past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m)
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Live call-duration readout, ticking once a second off `connectedAt`. Shared by
 * the mobile drawer and the desktop dock (INV-35) — both surfaces show it.
 */
export function CallTimer({ connectedAt, className }: { connectedAt: number | null; className?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed = connectedAt == null ? 0 : now - connectedAt
  return (
    <span className={cn("font-mono text-sm tabular-nums", className)} aria-label="Call duration">
      {formatElapsed(elapsed)}
    </span>
  )
}
