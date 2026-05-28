import { Bot } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useInviteEnclave, canInviteEnclave, isEnclaveInvited } from "@/hooks/use-invite-enclave"
import type { VirtualStream } from "@/hooks/use-stream-or-draft"

const pillBase = "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold"

interface InviteEnclaveButtonProps {
  workspaceId: string
  stream: VirtualStream
}

/**
 * Header affordance for inviting the first-party enclave agent (Ariadne) into
 * an encrypted scratchpad. Only shown for E2E scratchpads; renders an inert
 * pill once invited.
 */
export function InviteEnclaveButton({ workspaceId, stream }: InviteEnclaveButtonProps) {
  const { invite, isInviting } = useInviteEnclave(workspaceId, stream.id)

  if (!stream.e2eEnabled) return null

  if (isEnclaveInvited(stream)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(pillBase, "border-border bg-secondary text-foreground")}
            aria-label="Ariadne is in this scratchpad"
          >
            <Bot className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            <span>Ariadne</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>Ariadne is in this scratchpad.</TooltipContent>
      </Tooltip>
    )
  }

  if (!canInviteEnclave(stream)) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void invite()}
          disabled={isInviting}
          aria-label="Invite Ariadne to this scratchpad"
          className={cn(
            pillBase,
            "border-border bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
          )}
        >
          <Bot className="h-3 w-3" aria-hidden="true" />
          <span>{isInviting ? "Inviting…" : "Invite Ariadne"}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>Invite Ariadne into this encrypted scratchpad.</TooltipContent>
    </Tooltip>
  )
}
