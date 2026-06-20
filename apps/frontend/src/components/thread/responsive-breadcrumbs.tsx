import { useRef, useState, useEffect, useMemo } from "react"
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Skeleton } from "@/components/ui/skeleton"
import { AncestorBreadcrumbItem, CurrentBreadcrumbItem } from "./breadcrumb-helpers"
import { BreadcrumbEllipsisDropdown } from "./breadcrumb-ellipsis-dropdown"
import type { StreamType } from "@threa/types"

interface StreamInfo {
  id: string
  type: StreamType
  displayName: string | null
  slug?: string | null
  parentStreamId?: string | null
}

const BREAKPOINTS = {
  /** Below: only current item */
  MINIMAL: 200,
  /** Below: root > current */
  COMPACT: 300,
  /** Below: root + 1 ancestor > current */
  MEDIUM: 450,
  /** Above: show all or root + 2 ancestors > current */
  FULL: 600,
}

interface ResponsiveBreadcrumbsProps {
  ancestors: StreamInfo[]
  currentLabel: string
  isMainViewStream: (streamId: string) => boolean
  onClosePanel: () => void
  getNavigationUrl: (streamId: string) => string
  /** Show loading placeholder instead of ancestors */
  isLoading?: boolean
}

export function ResponsiveBreadcrumbs({
  ancestors,
  currentLabel,
  isMainViewStream,
  onClosePanel,
  getNavigationUrl,
  isLoading = false,
}: ResponsiveBreadcrumbsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(BREAKPOINTS.FULL)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })

    observer.observe(container)
    setContainerWidth(container.offsetWidth)

    return () => observer.disconnect()
  }, [])

  const maxVisibleAncestors = useMemo(() => {
    if (containerWidth < BREAKPOINTS.MINIMAL) return 0
    if (containerWidth < BREAKPOINTS.COMPACT) return 1
    if (containerWidth < BREAKPOINTS.MEDIUM) return 2
    if (containerWidth < BREAKPOINTS.FULL) return 3
    return Infinity
  }, [containerWidth])

  const { ancestorMaxWidth, currentMaxWidth } = useMemo(() => {
    const separatorWidth = 24
    const ellipsisWidth = 32
    const visibleAncestorCount = Math.min(ancestors.length, maxVisibleAncestors)
    const hasEllipsis = ancestors.length > maxVisibleAncestors && ancestors.length > 0

    // Each visible ancestor has a separator; the ellipsis has its own separator too
    const separatorCount = visibleAncestorCount + (hasEllipsis ? 1 : 0)
    const fixedOverhead = separatorCount * separatorWidth + (hasEllipsis ? ellipsisWidth : 0)
    const available = Math.max(0, containerWidth - fixedOverhead)

    if (visibleAncestorCount === 0) {
      return { ancestorMaxWidth: 0, currentMaxWidth: Math.min(available, 300) }
    }

    const currentShare = Math.min(200, Math.max(80, Math.floor(available * 0.5)))
    const ancestorBudget = available - currentShare
    const perAncestor = Math.max(40, Math.floor(ancestorBudget / visibleAncestorCount))

    return {
      ancestorMaxWidth: Math.min(perAncestor, 150),
      currentMaxWidth: currentShare,
    }
  }, [containerWidth, ancestors.length, maxVisibleAncestors])

  const renderAncestors = () => {
    if (ancestors.length === 0) return null

    if (maxVisibleAncestors === 0) {
      return (
        <BreadcrumbEllipsisDropdown
          items={ancestors}
          getNavigationUrl={getNavigationUrl}
          isMainViewStream={isMainViewStream}
          onClosePanel={onClosePanel}
        />
      )
    }

    if (ancestors.length <= maxVisibleAncestors) {
      return ancestors.map((ancestor) => (
        <AncestorBreadcrumbItem
          key={ancestor.id}
          stream={ancestor}
          isMainViewStream={isMainViewStream(ancestor.id)}
          onClosePanel={onClosePanel}
          getNavigationUrl={getNavigationUrl}
          maxWidth={ancestorMaxWidth}
        />
      ))
    }

    const first = ancestors[0]
    const tailCount = Math.max(0, maxVisibleAncestors - 1)
    const hidden = ancestors.slice(1, tailCount > 0 ? ancestors.length - tailCount : undefined)
    const tail = tailCount > 0 ? ancestors.slice(ancestors.length - tailCount) : []

    return (
      <>
        <AncestorBreadcrumbItem
          stream={first}
          isMainViewStream={isMainViewStream(first.id)}
          onClosePanel={onClosePanel}
          getNavigationUrl={getNavigationUrl}
          maxWidth={ancestorMaxWidth}
        />
        {hidden.length > 0 && (
          <BreadcrumbEllipsisDropdown
            items={hidden}
            getNavigationUrl={getNavigationUrl}
            isMainViewStream={isMainViewStream}
            onClosePanel={onClosePanel}
          />
        )}
        {tail.map((ancestor) => (
          <AncestorBreadcrumbItem
            key={ancestor.id}
            stream={ancestor}
            isMainViewStream={isMainViewStream(ancestor.id)}
            onClosePanel={onClosePanel}
            getNavigationUrl={getNavigationUrl}
            maxWidth={ancestorMaxWidth}
          />
        ))}
      </>
    )
  }

  return (
    <div ref={containerRef} className="min-w-0 flex-1 overflow-hidden">
      <Breadcrumb>
        <BreadcrumbList className="flex-nowrap">
          {isLoading ? (
            <>
              <BreadcrumbItem>
                <Skeleton className="h-4 w-20" />
              </BreadcrumbItem>
              <BreadcrumbSeparator />
            </>
          ) : (
            renderAncestors()
          )}
          <CurrentBreadcrumbItem label={currentLabel} maxWidth={currentMaxWidth} />
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  )
}
