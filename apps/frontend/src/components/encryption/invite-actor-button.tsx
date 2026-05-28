import { Bot } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useInviteActor, canInviteActor, isActorInvited, E2E_ACTOR_LABELS } from "@/hooks/use-invite-actor"
import type { E2eActorKind } from "@threa/types"
import type { VirtualStream } from "@/hooks/use-stream-or-draft"

const pillBase = "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold"

interface InviteActorButtonProps {
  workspaceId: string
  stream: VirtualStream
  kind: E2eActorKind
}

/**
 * Header affordance for inviting a non-human actor (e.g. the enclave agent
 * Ariadne) into an encrypted scratchpad. Only shown for E2E scratchpads;
 * renders an inert pill once that actor is invited.
 */
export function InviteActorButton({ workspaceId, stream, kind }: InviteActorButtonProps) {
  const { invite, isInviting } = useInviteActor(workspaceId, stream.id)
  const label = E2E_ACTOR_LABELS[kind]

  if (!stream.e2eEnabled) return null

  if (isActorInvited(stream, kind)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(pillBase, "border-border bg-secondary text-foreground")}
            aria-label={`${label} is in this scratchpad`}
          >
            <Bot className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            <span>{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{label} is in this scratchpad.</TooltipContent>
      </Tooltip>
    )
  }

  if (!canInviteActor(stream, kind)) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void invite(kind)}
          disabled={isInviting}
          aria-label={`Invite ${label} to this scratchpad`}
          className={cn(
            pillBase,
            "border-border bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
          )}
        >
          <Bot className="h-3 w-3" aria-hidden="true" />
          <span>{isInviting ? "Inviting…" : `Invite ${label}`}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>Invite {label} into this encrypted scratchpad.</TooltipContent>
    </Tooltip>
  )
}
