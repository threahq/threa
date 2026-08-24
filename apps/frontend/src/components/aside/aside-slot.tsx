import { useIsMobile } from "@/hooks/use-mobile"
import { useAsideForHost } from "@/stores/aside-store"
import { AsideStage } from "./aside-stage"
import { AsideMobileSheet } from "./aside-mobile-sheet"

interface AsideSlotProps {
  workspaceId: string
  hostKey: string
}

/**
 * The aside's surface, mounted by a page that can host one. There is exactly
 * one on each platform: the stage, which takes the content region with the
 * host stream beside it as reference, and — on a phone, where there is no room
 * to put two things side by side — a sheet over the host. Renders nothing
 * while no aside is open on this page.
 */
export function AsideSlot({ workspaceId, hostKey }: AsideSlotProps) {
  const current = useAsideForHost(hostKey)
  const isMobile = useIsMobile()
  if (!current) return null

  return isMobile ? (
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
