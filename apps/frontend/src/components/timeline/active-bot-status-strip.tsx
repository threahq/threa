import type { BotRuntimeStatus } from "@threa/types"
import { cn } from "../../lib/utils"

interface ActiveBotStatusStripProps {
  botName: string
  runtimeDisplayName: string | null
  status: BotRuntimeStatus | "unknown"
  className?: string
}

const STATUS_COPY: Record<BotRuntimeStatus | "unknown", string> = {
  available: "available",
  busy: "busy",
  offline: "offline",
  error: "error",
  unknown: "not linked",
}

export function ActiveBotStatusStrip({ botName, runtimeDisplayName, status, className }: ActiveBotStatusStripProps) {
  const detail = runtimeDisplayName ? `linked to ${runtimeDisplayName}` : "run /remote-control in Pi to connect"

  return (
    <div
      className={cn(
        "rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-sm text-muted-foreground",
        className
      )}
      aria-live="polite"
    >
      <span className="font-medium text-foreground">{botName}</span>
      <span aria-hidden="true"> · </span>
      <span>{STATUS_COPY[status]}</span>
      <span aria-hidden="true"> · </span>
      <span>{detail}</span>
    </div>
  )
}
