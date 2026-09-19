import { useState } from "react"
import { Bot } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/components/ui/responsive-alert-dialog"
import { cn } from "@/lib/utils"
import {
  useInviteActor,
  useRevokeActor,
  canInviteActor,
  E2E_ACTOR_LABELS,
} from "@/hooks/use-e2e-actors"
import type { E2eActorKind } from "@threahq/types"
import type { VirtualStream } from "@/hooks/use-stream-or-draft"

// `shrink-0` + nowrap: these pills live in the header's scrollable chip strip —
// they must keep their size and let the strip scroll, not squish or wrap.
const pillBase =
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold"

interface InviteActorButtonProps {
  workspaceId: string
  stream: VirtualStream
  kind: E2eActorKind
}

/**
 * Header affordance for inviting a non-human actor (e.g. the enclave agent
 * Ariadne) into an encrypted scratchpad, and for taking that grant back. Only
 * shown for E2E scratchpads.
 */
export function InviteActorButton({ workspaceId, stream, kind }: InviteActorButtonProps) {
  const { invite, isInviting } = useInviteActor(workspaceId, stream.id)
  const { revoke, isRevoking } = useRevokeActor(workspaceId, stream.id)
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)
  const label = E2E_ACTOR_LABELS[kind]

  if (!stream.e2eEnabled) return null

  // Revoke names the actor row as listed, so read the pinned id off the stream
  // rather than assuming the kind's sentinel.
  const invitedActor = stream.e2eActors?.find((a) => a.kind === kind)

  if (invitedActor) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setConfirmingRevoke(true)}
              disabled={isRevoking}
              aria-label={`Remove ${label} from this scratchpad`}
              className={cn(
                pillBase,
                "border-border bg-secondary text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
              )}
            >
              <Bot className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
              <span>{label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{label} is in this scratchpad. Click to remove.</TooltipContent>
        </Tooltip>

        <ResponsiveAlertDialog open={confirmingRevoke} onOpenChange={setConfirmingRevoke}>
          <ResponsiveAlertDialogContent>
            <ResponsiveAlertDialogHeader>
              <ResponsiveAlertDialogTitle>Remove {label} from this scratchpad?</ResponsiveAlertDialogTitle>
              <ResponsiveAlertDialogDescription>
                {label} loses access to everything sent from now on, and the copies of the key it was given are
                deleted. Messages it already read stay readable to it.
              </ResponsiveAlertDialogDescription>
            </ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogFooter>
              <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
              <ResponsiveAlertDialogAction
                onClick={() => {
                  setConfirmingRevoke(false)
                  void revoke(kind, invitedActor.actorId)
                }}
              >
                Remove {label}
              </ResponsiveAlertDialogAction>
            </ResponsiveAlertDialogFooter>
          </ResponsiveAlertDialogContent>
        </ResponsiveAlertDialog>
      </>
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
