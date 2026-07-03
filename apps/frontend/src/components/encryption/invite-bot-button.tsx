import { useQuery } from "@tanstack/react-query"
import { Bot as BotIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { botsApi } from "@/api/bots"
import { useInviteActor } from "@/hooks/use-invite-actor"
import { StreamTypes } from "@threa/types"
import type { VirtualStream } from "@/hooks/use-stream-or-draft"

const pillBase = "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold"

interface InviteBotButtonProps {
  workspaceId: string
  stream: VirtualStream
}

/**
 * Header affordance for inviting a workspace bot (a self-hosted harness like
 * the Pi remote or the Claude Code channel) into an encrypted scratchpad — the
 * owner's deliberate consent act that wraps the stream key to the bot's
 * identity key so it can serve sealed turns (design §2.6). Invited bots render
 * as inert pills; the picker lists the rest.
 */
export function InviteBotButton({ workspaceId, stream }: InviteBotButtonProps) {
  const { invite, isInviting, isUnlocked } = useInviteActor(workspaceId, stream.id)
  const eligible = stream.type === StreamTypes.SCRATCHPAD && !stream.isDraft && stream.e2eEnabled === true
  const { data: bots } = useQuery({
    queryKey: ["bots", workspaceId],
    queryFn: () => botsApi.list(workspaceId),
    enabled: eligible,
    staleTime: 60_000,
  })

  if (!eligible) return null

  const invitedBotIds = new Set((stream.e2eActors ?? []).filter((a) => a.kind === "bot").map((a) => a.actorId))
  const invited = (bots ?? []).filter((bot) => invitedBotIds.has(bot.id))
  const candidates = (bots ?? []).filter((bot) => !bot.archivedAt && !invitedBotIds.has(bot.id))

  return (
    <>
      {invited.map((bot) => (
        <Tooltip key={bot.id}>
          <TooltipTrigger asChild>
            <span
              className={cn(pillBase, "border-border bg-secondary text-foreground")}
              aria-label={`${bot.name} can read this scratchpad`}
            >
              <BotIcon className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
              <span>{bot.name}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{bot.name} can read this encrypted scratchpad.</TooltipContent>
        </Tooltip>
      ))}
      {/* Wrapping the key to the bot needs the owner's unlocked credentials —
          gate the affordance so the actor is never recorded unwrapped. */}
      {isUnlocked && candidates.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={isInviting}
              aria-label="Invite an agent to this scratchpad"
              className={cn(
                pillBase,
                "border-border bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
              )}
            >
              <BotIcon className="h-3 w-3" aria-hidden="true" />
              <span>{isInviting ? "Inviting…" : "Invite agent"}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal text-muted-foreground">
              An invited agent will be able to read this encrypted scratchpad.
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {candidates.map((bot) => (
              <DropdownMenuItem key={bot.id} onSelect={() => void invite("bot", bot.id)}>
                <span className="mr-1">{bot.avatarEmoji ?? "🤖"}</span>
                {bot.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  )
}
