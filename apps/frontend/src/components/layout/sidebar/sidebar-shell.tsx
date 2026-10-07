import { createContext, useContext, type ReactNode } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"

interface SidebarShellProps {
  header: ReactNode
  body: ReactNode
  footer?: ReactNode
}

const SidebarShellBody = createContext<ReactNode>(null)

function SidebarShellBodyOutlet() {
  return useContext(SidebarShellBody)
}

// One element for every render: the owner rebuilds `body` several times per
// incoming message, and reaching it through context instead of children keeps
// the scroll area's subtree out of those renders.
const SCROLL_BODY = (
  <ScrollArea className="h-full [&>div>div]:!block [&>div>div]:!w-full">
    <div className="p-2">
      <SidebarShellBodyOutlet />
    </div>
  </ScrollArea>
)

/**
 * Sidebar structural shell: pinned header, single scroll area body, pinned footer.
 *
 * Collapsed state is handled by app-shell.tsx, so this component renders content
 * without reacting to collapse state.
 */
export function SidebarShell({ header, body, footer }: SidebarShellProps) {
  return (
    <div className="relative flex h-full flex-col">
      <div className="flex-shrink-0">{header}</div>

      <div className="flex-1 overflow-hidden">
        <SidebarShellBody.Provider value={body}>{SCROLL_BODY}</SidebarShellBody.Provider>
      </div>

      {footer && <div className="flex-shrink-0 border-t px-2 py-2">{footer}</div>}
    </div>
  )
}
