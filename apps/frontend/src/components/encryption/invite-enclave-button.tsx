import { useState } from "react"
import { Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { canInviteEnclave, isEnclaveInvited, useInviteEnclave } from "@/hooks/use-invite-enclave"

interface InviteEnclaveButtonProps {
  workspaceId: string
  streamId: string
  stream: { e2eEnabled?: boolean; e2eInvitedAgentKind?: string | null } | undefined
}

/**
 * Header chip for E2E scratchpads:
 *   - shows "Invite Ariadne" when no agent is invited yet;
 *   - shows a static "Ariadne is here" badge once invited so the owner can
 *     verify the enclave is in the recipient list before typing anything
 *     sensitive (the recipients popover comes later).
 *
 * Hidden for plaintext streams.
 */
export function InviteEnclaveButton({ workspaceId, streamId, stream }: InviteEnclaveButtonProps) {
  const { invite, pending } = useInviteEnclave(workspaceId, streamId)
  const [error, setError] = useState<string | null>(null)

  if (!stream || stream.e2eEnabled !== true) return null

  if (isEnclaveInvited(stream)) {
    return (
      <Badge variant="secondary" className="gap-1" title="Ariadne (enclave) is a recipient on this scratchpad">
        <Sparkles className="h-3 w-3" />
        Ariadne
      </Badge>
    )
  }

  if (!canInviteEnclave(stream)) return null

  const handleClick = async () => {
    setError(null)
    try {
      await invite()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't invite Ariadne")
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={handleClick}
      disabled={pending}
      title={error ?? "Add Ariadne (enclave) as a per-message recipient"}
    >
      <Sparkles className="h-3 w-3" />
      {pending ? "Inviting…" : "Invite Ariadne"}
    </Button>
  )
}
