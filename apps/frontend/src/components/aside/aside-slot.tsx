import { useIsMobileOrCoarse } from "@/hooks/use-pointer"
import { useAsideForHost } from "@/stores/aside-store"
import { AsideStage } from "./aside-stage"
import { AsideMobileSheet } from "./aside-mobile-sheet"

/**
 * Whether the aside shows as a sheet rather than the stage. One predicate, read
 * by the slot AND by the page that stands its own timeline down for the stage:
 * two derivations of "is this a phone" drift, and the drift here mounts two
 * live timelines on the same stream (a coarse-pointer tablet is wide).
 */
export function useAsideIsSheet(): boolean {
  return useIsMobileOrCoarse()
}

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
