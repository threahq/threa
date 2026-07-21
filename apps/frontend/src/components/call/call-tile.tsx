import { useEffect, useRef, useState } from "react"
import { MicOff } from "lucide-react"
import { getAvatarUrl } from "@threa/types"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import type { CallRosterParticipant } from "@/stores/call-store"
import { resolveSelfMirror, useCallPrefs } from "@/stores/call-prefs-store"
import { useCallManager } from "./call-manager-context"
import { useCallDevices, useCallMediaEpoch, useCallMuted, useSpeakingLevelRef } from "./call-store-hooks"

interface CallTileProps {
  participant: CallRosterParticipant
  workspaceId: string | null
  isSelf: boolean
  /** Near-black `--call-stage` bed (mobile drawer / fullscreen), not the default `bg-muted` chrome tile. */
  stage?: boolean
  /** Fill the parent (fullscreen active speaker) instead of the default `aspect-video`. */
  fill?: boolean
}

/**
 * One participant. Video attaches by ref from the manager's per-endpoint stream
 * registry (media objects never enter the store snapshot — {@link useCallMediaEpoch}
 * is the version tick that re-runs the attach). The self tile's speaking ring is
 * ref-driven (`useSpeakingLevelRef`) so the analyser's per-frame level never
 * re-renders the tile, let alone the dock.
 */
export function CallTile({ participant, workspaceId, isSelf, stage = false, fill = false }: CallTileProps) {
  const users = useWorkspaceUsers(workspaceId ?? undefined)
  const user = users.find((u) => u.id === participant.userId)
  const name = user?.name ?? "Unknown"
  const avatarUrl = user && workspaceId ? getAvatarUrl(workspaceId, user.avatarUrl, 64) : undefined

  const mediaEpoch = useCallMediaEpoch()
  const manager = useCallManager()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [hasVideo, setHasVideo] = useState(false)
  const endpointId = participant.endpointId

  useEffect(() => {
    const el = videoRef.current
    const stream = endpointId ? manager.getVideoStream(endpointId) : null
    if (el) el.srcObject = stream
    setHasVideo(!!stream)
    // mediaEpoch bumps whenever the manager's video ref-map changes.
    return () => {
      // Null the binding on unmount (symmetric with detachRemoteAudio); the manager
      // owns the MediaStream lifecycle, so this only drops the element's reference.
      if (el) el.srcObject = null
    }
  }, [manager, endpointId, mediaEpoch])

  // Only the local participant carries a live speaking level; remote peers have
  // none in v1, so the ring is self-only.
  const selfMuted = useCallMuted()
  const speakingRef = useSpeakingLevelRef<HTMLDivElement>()
  const muted = isSelf ? selfMuted : participant.mediaState.muted === true
  const reconnecting = participant.connectionStatus === "reconnecting"

  // Mirror ONLY the local self-view (peers always see the un-mirrored feed). A
  // mirrored self-view feels natural like a bathroom mirror; `auto` follows the
  // camera facing (front/desktop mirror, mobile back normal).
  const { selfMirror } = useCallPrefs()
  const { facingMode } = useCallDevices()
  const isMobile = useIsMobile()
  const mirror = isSelf && resolveSelfMirror(selfMirror, { isMobile, facingMode })

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md",
        fill ? "h-full w-full" : "aspect-video",
        stage ? "bg-call-stage" : "bg-muted",
        reconnecting && "opacity-50"
      )}
      data-testid="call-tile"
      data-user-id={participant.userId}
    >
      {isSelf && (
        <div
          ref={speakingRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-primary"
          // Ref-driven: opacity tracks the CSS var written each analyser frame.
          style={{ opacity: "var(--speaking-level, 0)" }}
        />
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={cn("h-full w-full object-cover", mirror && "-scale-x-100", !hasVideo && "hidden")}
        data-testid="call-tile-video"
      />
      {!hasVideo && (
        <div className={cn("flex h-full w-full items-center justify-center", stage && "bg-call-stage-2")}>
          <Avatar className="h-12 w-12">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={name} />}
            <AvatarFallback>{getInitials(name)}</AvatarFallback>
          </Avatar>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/60 to-transparent px-2 py-1">
        {muted && <MicOff className="h-3 w-3 text-white" aria-label="Muted" />}
        <span className="truncate text-xs font-medium text-white">
          {name}
          {isSelf && " (you)"}
        </span>
        {reconnecting && <span className="ml-auto text-[10px] text-white/80">Reconnecting…</span>}
      </div>
    </div>
  )
}
