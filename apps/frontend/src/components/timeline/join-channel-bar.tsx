import { useState } from "react"
import { Hash } from "lucide-react"
import { Button } from "@/components/ui/button"
import { streamsApi } from "@/api"
import { useComposerHeightPublish } from "@/hooks"
import type { StreamMember } from "@threahq/types"

interface JoinChannelBarProps {
  workspaceId: string
  streamId: string
  channelName: string
  onJoined: (membership: StreamMember) => void
  onHeightChange?: (px: number, opts: { initial: boolean }) => void
}

export function JoinChannelBar({ workspaceId, streamId, channelName, onJoined, onHeightChange }: JoinChannelBarProps) {
  const [isJoining, setIsJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The join bar stands in for the composer for non-members, so it must own
  // `--composer-height` while it's mounted: the timeline scroller docks above
  // that variable, and the composer that would otherwise set it is not rendered
  // for non-members. Without this the scroller keeps the stale height a prior
  // composer left behind and the bar can float over messages.
  const composerHeightRef = useComposerHeightPublish({ onHeightChange })

  const handleJoin = async () => {
    setIsJoining(true)
    setError(null)
    try {
      const membership = await streamsApi.join(workspaceId, streamId)
      onJoined(membership)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to join channel")
    } finally {
      setIsJoining(false)
    }
  }

  return (
    <div ref={composerHeightRef} className="flex flex-col items-center gap-3 border-t bg-background px-4 py-6">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span>You're viewing</span>
        <span className="inline-flex items-center gap-0.5 font-medium text-foreground">
          <Hash className="h-3.5 w-3.5" />
          {channelName}
        </span>
      </div>
      <Button onClick={handleJoin} disabled={isJoining} size="sm">
        {isJoining ? "Joining..." : "Join Channel"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
