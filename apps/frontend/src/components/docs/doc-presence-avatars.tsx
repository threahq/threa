import { useSyncExternalStore } from "react"
import { ActorAvatar } from "@/components/actor-avatar"
import { useUserProfile } from "@/components/user-profile"
import type { DocPresence } from "@/lib/docs/doc-presence"

const MAX_SHOWN = 3

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
  const extra = peers.length - shown.length
  return (
    <div data-testid="doc-presence" className="flex shrink-0 items-center -space-x-1.5">
      {shown.map((peer) => (
        <button
          key={peer.userId}
          type="button"
          aria-label={peer.name}
          title={peer.name}
          onClick={() => openUserProfile(peer.userId)}
          className="relative rounded-[7px] border-2 bg-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ borderColor: peer.color }}
        >
          <ActorAvatar actorId={peer.userId} actorType="user" workspaceId={workspaceId} size="xs" showStatus={false} />
        </button>
      ))}
      {extra > 0 && (
        <span className="relative flex h-6 min-w-6 items-center justify-center rounded-[7px] border-2 border-background bg-muted px-1 text-[9px] font-medium text-muted-foreground">
          +{extra}
        </span>
      )}
    </div>
  )
}
