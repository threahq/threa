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
  offline: "Offline",
  error: "Error",
  unknown: "Not linked",
}

const STATUS_DOT_CLASS: Record<BotRuntimeStatus | "unknown", string> = {
  available: "bg-emerald-500",
  busy: "animate-pulse bg-amber-500",
  offline: "bg-muted-foreground/40",
  error: "animate-pulse bg-destructive",
  unknown: "bg-muted-foreground/40",
}

export function ActiveBotStatusStrip({ botName, runtimeDisplayName, status, className }: ActiveBotStatusStripProps) {
  const detail = runtimeDisplayName ? runtimeDisplayName : "run /remote-control in Pi to connect"

  return (
    <div
      className={cn(
        "relative z-30 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground shadow-lg ring-1 ring-background/80",
        className
      )}
      aria-live="polite"
    >
      <span className={cn("inline-block size-2 rounded-full", STATUS_DOT_CLASS[status])} aria-hidden="true" />
      <span className="ml-2 font-medium text-foreground">{botName}</span>
      <span aria-hidden="true"> · </span>
      <span>{STATUS_COPY[status]}</span>
      <span aria-hidden="true"> · </span>
      <span>{detail}</span>
    </div>
  )
}
