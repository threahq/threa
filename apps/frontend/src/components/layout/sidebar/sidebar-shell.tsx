import type { ReactNode } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"

interface SidebarShellProps {
  header: ReactNode
  body: ReactNode
  footer?: ReactNode
}

/**
 * Sidebar structural shell: pinned header, single scroll area body, pinned footer.
 *
 * Collapsed state is handled by app-shell.tsx (it clips the sidebar to 6px), so
 * this component renders content without reacting to collapse state.
 */
export function SidebarShell({ header, body, footer }: SidebarShellProps) {
  return (
    <div className="relative flex h-full flex-col">
      <div className="flex-shrink-0">{header}</div>

      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full [&>div>div]:!block [&>div>div]:!w-full">
          <div className="p-2">{body}</div>
        </ScrollArea>
      </div>

      {footer && <div className="flex-shrink-0 border-t px-2 py-2">{footer}</div>}
    </div>
  )
}
