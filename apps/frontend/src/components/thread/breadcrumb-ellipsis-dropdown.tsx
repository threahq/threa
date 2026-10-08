import { Link } from "react-router-dom"
import { BreadcrumbItem, BreadcrumbEllipsis, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { streamLabel } from "@/lib/streams"
import type { StreamType } from "@threahq/types"

interface StreamInfo {
  id: string
  type: StreamType
  displayName: string | null
  slug?: string | null
}

interface BreadcrumbEllipsisDropdownProps {
  items: StreamInfo[]
  getNavigationUrl: (streamId: string) => string
}

export function BreadcrumbEllipsisDropdown({ items, getNavigationUrl }: BreadcrumbEllipsisDropdownProps) {
  if (items.length === 0) return null

  return (
    <div className="contents">
      <BreadcrumbItem>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-1 hover:bg-accent rounded-sm">
            <BreadcrumbEllipsis className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {items.map((item) => (
              <DropdownMenuItem key={item.id} asChild>
                <Link to={getNavigationUrl(item.id)}>{streamLabel(item, "breadcrumb")}</Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
    </div>
  )
}
