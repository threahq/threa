import { useSyncExternalStore } from "react"
import { ActorAvatar } from "@/components/actor-avatar"
import { useUserProfile } from "@/components/user-profile"
import type { DocPresence } from "@/lib/docs/doc-presence"
import { cn } from "@/lib/utils"

const MAX_SHOWN = 3

/** A 2px ring around the 20px xs avatar; its 7px radius is the avatar's 5px plus the ring, so the corners stay concentric. */
const RING_CLASS = "rounded-[7px] border-2"

interface DocPresenceAvatarsProps {
  workspaceId: string
  presence: DocPresence
}

/** The other people in this doc right now, one avatar per person however many tabs they have open. */
export function DocPresenceAvatars({ workspaceId, presence }: DocPresenceAvatarsProps) {
  const peers = useSyncExternalStore(presence.subscribe, presence.peers)
  const { openUserProfile } = useUserProfile()
  if (peers.length === 0) return null

  const shown = peers.slice(0, MAX_SHOWN)
  const hidden = peers.slice(MAX_SHOWN)
  const hiddenNames = hidden.map((peer) => peer.name).join(", ")
  return (
    <div data-testid="doc-presence" className="flex shrink-0 items-center -space-x-1.5">
      {shown.map((peer) => (
        <button
          key={peer.userId}
          type="button"
          aria-label={peer.name}
          title={peer.name}
          onClick={() => openUserProfile(peer.userId)}
          className={cn(
            "relative bg-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            RING_CLASS
          )}
          style={{ borderColor: peer.color }}
        >
          <ActorAvatar actorId={peer.userId} actorType="user" workspaceId={workspaceId} size="xs" showStatus={false} />
        </button>
      ))}
      {hidden.length > 0 && (
        <span
          role="img"
          title={hiddenNames}
          aria-label={hiddenNames}
          className={cn(
            "relative flex h-6 min-w-6 items-center justify-center border-background bg-muted px-1 text-[9px] font-medium text-muted-foreground",
            RING_CLASS
          )}
        >
          +{hidden.length}
        </span>
      )}
    </div>
  )
}
