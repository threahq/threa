import { useCallback, useEffect, useMemo, useState } from "react"
import type { SearchCluster } from "@/api"

export interface ClusterExpansion {
  /** Stable list key for a row, shared by both display modes. */
  key: (cluster: SearchCluster) => string
  isExpanded: (cluster: SearchCluster) => boolean
  expand: (cluster: SearchCluster) => void
}

function clusterKey(cluster: SearchCluster, index: number): string {
  return cluster.conversation?.id ?? cluster.hits[0]?.id ?? `${cluster.streamId}:${index}`
}

/** Which rows show all their hits; a keyboard-selected hit opens the row holding it. */
export function useClusterExpansion(
  clusters: readonly SearchCluster[],
  activeResultId: string | null
): ClusterExpansion {
  const keys = useMemo(
    () => new Map(clusters.map((cluster, index) => [cluster, clusterKey(cluster, index)])),
    [clusters]
  )
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!activeResultId) return
    const cluster = clusters.find((candidate) => candidate.hits.some((hit) => hit.id === activeResultId))
    const key = cluster && keys.get(cluster)
    if (!key) return
    setExpandedKeys((current) => (current.has(key) ? current : new Set(current).add(key)))
  }, [activeResultId, clusters, keys])

  const key = useCallback((cluster: SearchCluster) => keys.get(cluster)!, [keys])
  const isExpanded = useCallback((cluster: SearchCluster) => expandedKeys.has(keys.get(cluster)!), [expandedKeys, keys])
  const expand = useCallback(
    (cluster: SearchCluster) => setExpandedKeys((current) => new Set(current).add(keys.get(cluster)!)),
    [keys]
  )

  return { key, isExpanded, expand }
}
