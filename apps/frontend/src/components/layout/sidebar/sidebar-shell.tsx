import type { ReactNode, RefObject } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"

interface SidebarShellProps {
  header: ReactNode
  body: ReactNode
  footer?: ReactNode
  sidebarRef?: RefObject<HTMLDivElement | null>
  /** Inner scroll container; stream items read it for position tracking. */
  scrollContainerRef?: RefObject<HTMLDivElement | null>
}

/**
 * Sidebar structural shell: pinned header, single scroll area body, pinned footer.
 *
 * Collapsed state is handled by app-shell.tsx (it clips the sidebar to 6px), so
 * this component renders content without reacting to collapse state.
 */
export function SidebarShell({ header, body, footer, sidebarRef, scrollContainerRef }: SidebarShellProps) {
  return (
    <div ref={sidebarRef} className="relative flex h-full flex-col">
      <div className="flex-shrink-0">{header}</div>

      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full [&>div>div]:!block [&>div>div]:!w-full">
          <div ref={scrollContainerRef} className="p-2">
            {body}
          </div>
        </ScrollArea>
      </div>

      {footer && <div className="flex-shrink-0 border-t px-2 py-2">{footer}</div>}
    </div>
  )
}
