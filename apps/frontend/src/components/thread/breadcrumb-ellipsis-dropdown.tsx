import { Link } from "react-router-dom"
import { BreadcrumbItem, BreadcrumbEllipsis, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { streamLabel } from "@/lib/streams"
import type { StreamType } from "@threa/types"

interface StreamInfo {
  id: string
  type: StreamType
  displayName: string | null
  slug?: string | null
}

interface BreadcrumbEllipsisDropdownProps {
  items: StreamInfo[]
  getNavigationUrl: (streamId: string) => string
  isMainViewStream: (streamId: string) => boolean
  onClosePanel: () => void
}

export function BreadcrumbEllipsisDropdown({
  items,
  getNavigationUrl,
  isMainViewStream,
  onClosePanel,
}: BreadcrumbEllipsisDropdownProps) {
  if (items.length === 0) return null

  return (
    <div className="contents">
      <BreadcrumbItem>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-1 hover:bg-accent rounded-sm">
            <BreadcrumbEllipsis className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {items.map((item) => {
              const displayName = streamLabel(item, "breadcrumb")

              if (isMainViewStream(item.id)) {
                return (
                  <DropdownMenuItem key={item.id} onClick={onClosePanel}>
                    {displayName}
                  </DropdownMenuItem>
                )
              }

              return (
                <DropdownMenuItem key={item.id} asChild>
                  <Link to={getNavigationUrl(item.id)}>{displayName}</Link>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
    </div>
  )
}
