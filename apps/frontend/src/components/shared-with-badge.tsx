import { Building2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useStreamBootstrap } from "@/hooks/use-streams"
import type { CachedStreamBootstrap } from "@/sync/stream-sync"
import { cn } from "@/lib/utils"

interface SharedWithBadgeProps {
  workspaceId: string
  stream: { id: string; rootStreamId?: string | null }
  className?: string
  wrap?: boolean
}

function pickConnectedWorkspaces(bootstrap: CachedStreamBootstrap) {
  return bootstrap.connectedWorkspaces
}

/** Names the other workspaces a shared channel, or a thread in one, is connected to. */
export function SharedWithBadge({ workspaceId, stream, className, wrap = false }: SharedWithBadgeProps) {
  const { data: connectedWorkspaces } = useStreamBootstrap(workspaceId, stream.rootStreamId ?? stream.id, {
    select: pickConnectedWorkspaces,
  })
  if (!connectedWorkspaces?.length) return null

  const label = `Shared with ${connectedWorkspaces.map((workspace) => workspace.name).join(", ")}`
  return (
    <Badge variant="secondary" className={cn("gap-1", !wrap && "max-w-64", className)} title={label}>
      <Building2 className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className={cn(!wrap && "truncate")}>{label}</span>
    </Badge>
  )
}
