import type { StreamEvent } from "@threahq/types"
import { useActors } from "@/hooks"

interface MembershipEventProps {
  event: StreamEvent
  workspaceId: string
}

function getAction(event: StreamEvent): string {
  switch (event.eventType) {
    case "member_joined":
      return "joined the conversation"
    case "member_added":
      return "was added to the conversation"
    case "member_left":
      return "left the conversation"
    default:
      return "updated their membership"
  }
}

export function MembershipEvent({ event, workspaceId }: MembershipEventProps) {
  const { getActorName } = useActors(workspaceId)
  const actorName = getActorName(event.actorId, event.actorType)
  const action = getAction(event)

  return (
    <div className="py-2 px-3 sm:px-6 text-center">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium">{actorName}</span> {action}
      </p>
    </div>
  )
}
