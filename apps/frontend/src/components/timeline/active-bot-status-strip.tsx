import type { BotRuntimeStatus } from "@threa/types"
import { cn } from "../../lib/utils"

interface ActiveBotStatusStripProps {
  botName: string
  runtimeDisplayName: string | null
  status: BotRuntimeStatus | "unknown"
  className?: string
}

const STATUS_COPY: Record<BotRuntimeStatus | "unknown", string> = {
  available: "Available",
  busy: "Working",
  offline: "Not connected",
  error: "Not connected",
  unknown: "Not connected",
}

export function ActiveBotStatusStrip({ botName, runtimeDisplayName, status, className }: ActiveBotStatusStripProps) {
  const isConnected = status === "available" || status === "busy"
  const statusCopy = STATUS_COPY[status]
  const detail = isConnected ? runtimeDisplayName?.trim() || null : null

  return (
    <div
      className={cn(
        "relative z-30 inline-flex max-w-[min(26rem,calc(100vw-2rem))] items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[11px] font-medium tracking-wide text-muted-foreground shadow-sm ring-1 ring-border",
        className
      )}
      aria-live="polite"
    >
      <span
        className={cn(
          "inline-block size-2 shrink-0 rounded-full",
          isConnected ? "bg-emerald-500" : "bg-muted-foreground/40"
        )}
        aria-hidden="true"
      />
      <span className="shrink-0 text-foreground">{botName}</span>
      <span className="shrink-0" aria-hidden="true">
        {" "}
        ·{" "}
      </span>
      <span className="shrink-0">{statusCopy}</span>
      {detail && (
        <>
          <span className="shrink-0" aria-hidden="true">
            {" "}
            ·{" "}
          </span>
          {/* RTL truncation so the tail of the path (e.g. the project folder)
              stays visible while a long prefix is replaced by an ellipsis. The
              leading LRM keeps neutral characters like `/` rendering LTR. */}
          <span className="min-w-0 truncate" style={{ direction: "rtl", textAlign: "left" }}>
            {`‎${detail}`}
          </span>
        </>
      )}
    </div>
  )
}
