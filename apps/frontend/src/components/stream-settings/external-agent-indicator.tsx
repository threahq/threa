import { BotRuntimeStatuses } from "@threahq/types"
import { cn } from "@/lib/utils"
import type { ActiveBotPresence } from "@/hooks/use-active-bot-presence"

interface ExternalAgentIndicatorProps {
  agent: ActiveBotPresence
}

/**
 * Read-only signal that an external agent (a bot runtime, e.g. a Pi remote) is
 * attached to this scratchpad. External attachment is orthogonal to companion
 * mode — it's granted through bot channel access, not the companion radio — so
 * the settings surfaces show it rather than letting it hide behind a Quiet/
 * Companion choice that doesn't describe it. The green dot mirrors the header
 * pill: connected when the runtime is available/busy, grey otherwise.
 */
export function ExternalAgentIndicator({ agent }: ExternalAgentIndicatorProps) {
  const connected =
    agent.presence?.status === BotRuntimeStatuses.AVAILABLE || agent.presence?.status === BotRuntimeStatuses.BUSY

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/50 p-3">
      <span
        className={cn(
          "mt-1 inline-block size-2 shrink-0 rounded-full",
          connected ? "bg-emerald-500" : "bg-muted-foreground/40"
        )}
        aria-hidden="true"
      />
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-foreground">
          {agent.bot.avatarEmoji ? `${agent.bot.avatarEmoji} ` : ""}
          {agent.bot.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {connected
            ? "External agent connected — it reads and replies to messages here."
            : "External agent attached, not connected — it will read and reply once its runtime reconnects."}
        </p>
      </div>
    </div>
  )
}
