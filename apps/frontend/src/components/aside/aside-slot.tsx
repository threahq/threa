import { useAsideForHost } from "@/stores/aside-store"
import { AsideStage } from "./aside-stage"
import { AsideMobileSheet } from "./aside-mobile-sheet"
import { useAsideIsSheet } from "./aside-presentation"

interface AsideSlotProps {
  workspaceId: string
  hostKey: string
}

/**
 * The aside as a surface over the page, for a page that doesn't lay it out as
 * a column of its own: the board's stage, which takes the content region with
 * the host stream beside it as reference, and — where there is no room to put
 * two things side by side — a sheet over the host. Renders nothing while no
 * aside is open on this page.
 */
export function AsideSlot({ workspaceId, hostKey }: AsideSlotProps) {
  const current = useAsideForHost(hostKey)
  const isSheet = useAsideIsSheet()
  if (!current) return null

  return isSheet ? (
    <AsideMobileSheet
      workspaceId={workspaceId}
      asideId={current.asideId}
      hostStreamId={current.hostStreamId}
      originScope={current.originScope}
    />
  ) : (
    <AsideStage
      workspaceId={workspaceId}
      asideId={current.asideId}
      hostStreamId={current.hostStreamId}
      originScope={current.originScope}
    />
  )
}
