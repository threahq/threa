import { useState } from "react"
import { CornerDownRight } from "lucide-react"
import type { StreamEvent, MessagesMovedEventPayload } from "@threahq/types"
import { useActors } from "@/hooks"
import { MovedMessagesDrawer } from "./moved-messages-drawer"

interface MessagesMovedEventProps {
  event: StreamEvent
  workspaceId: string
}

/**
 * Source-side `messages:moved` tombstone. Renders as a single line —
 * "Actor moved N messages" — that opens the move drill-in drawer.
 *
 * Destination-side rows are filtered out one level up in
 * `event-item.tsx`, so this component is only mounted on the source
 * stream. At the destination the user reaches the same drawer via the
 * per-message origin badge or the "Show move details" context-menu
 * entry on each moved message.
 */
export function MessagesMovedEvent({ event, workspaceId }: MessagesMovedEventProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const actors = useActors(workspaceId)
  const payload = event.payload as MessagesMovedEventPayload
  const moverName = actors.getActorName(event.actorId, event.actorType)

  const count = payload.messages.length
  const noun = count === 1 ? "message" : "messages"

  return (
    <>
      <div className="py-2 px-3 sm:px-6 text-center">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center justify-center gap-1.5 hover:underline underline-offset-2"
          aria-label={`Show ${count} moved ${noun}`}
        >
          <CornerDownRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium">{moverName}</span> moved {count} {noun}
          </span>
        </button>
      </div>
      {drawerOpen && (
        <MovedMessagesDrawer open={drawerOpen} onOpenChange={setDrawerOpen} event={event} workspaceId={workspaceId} />
      )}
    </>
  )
}
