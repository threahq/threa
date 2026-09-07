import { useCallback, useEffect, useState } from "react"
import type { SearchCluster } from "@/api"

export interface StreamGroupCollapse {
  collapsedStreamIds: ReadonlySet<string>
  toggle: (streamId: string) => void
}

const NONE_COLLAPSED: ReadonlySet<string> = new Set<string>()

/** Which stream groups are folded shut; a new result set opens every group again. */
export function useStreamGroupCollapse(clusters: readonly SearchCluster[]): StreamGroupCollapse {
  const [collapsedStreamIds, setCollapsedStreamIds] = useState<ReadonlySet<string>>(NONE_COLLAPSED)

  useEffect(() => {
    setCollapsedStreamIds((current) => (current.size === 0 ? current : NONE_COLLAPSED))
  }, [clusters])

  const toggle = useCallback((streamId: string) => {
    setCollapsedStreamIds((current) => {
      const next = new Set(current)
      if (!next.delete(streamId)) next.add(streamId)
      return next
    })
  }, [])

  return { collapsedStreamIds, toggle }
}
