import { BotRuntimeStatuses } from "@threahq/types"
import { cn } from "@/lib/utils"
import { SettingLinkRow } from "@/components/settings/setting-primitives"
import type { ActiveBotPresence } from "@/hooks/use-active-bot-presence"

interface ExternalAgentIndicatorProps {
  agent: ActiveBotPresence
  /** Tighter, for the agent panel outside the settings window. */
  compact?: boolean
}

/**
 * Read-only row saying an external agent (a bot runtime, e.g. a Pi remote) is
 * attached to this scratchpad. External attachment is orthogonal to companion
 * mode — it's granted through bot channel access, not the companion radio — so
 * the settings surfaces show it rather than letting it hide behind a Quiet/
 * Companion choice that doesn't describe it. The green dot mirrors the header
 * pill; the sentence says the same, so the state never rests on colour.
 */
export function ExternalAgentIndicator({ agent, compact = false }: ExternalAgentIndicatorProps) {
  const connected =
    agent.presence?.status === BotRuntimeStatuses.AVAILABLE || agent.presence?.status === BotRuntimeStatuses.BUSY

  return (
    <SettingLinkRow
      href={null}
      compact={compact}
      label={
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", connected ? "bg-emerald-500" : "bg-muted-foreground/40")}
          />
          {agent.bot.avatarEmoji ? `${agent.bot.avatarEmoji} ` : ""}
          {agent.bot.name}
        </span>
      }
      description={
        connected
          ? "External agent, connected. It reads and replies to messages here."
          : "External agent, not connected. It reads and replies once its runtime reconnects."
      }
    />
  )
}
