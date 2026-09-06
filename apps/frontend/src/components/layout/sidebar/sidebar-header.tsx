import { useState } from "react"
import { Command, FileText, Search as SearchIcon, Terminal } from "lucide-react"
import { Link } from "react-router-dom"
import { useQuickSwitcher, usePreferences, useSidebar } from "@/contexts"
import { useSearchPanel } from "@/components/search/search-panel-context"
import { useInputMode } from "@/hooks/use-input-mode"
import { ThreaLogo } from "@/components/threa-logo"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SidebarToggle } from "@/components/layout/sidebar-toggle"
import { getEffectiveKeyBinding, formatKeyBinding, formatKeyBindingText } from "@/lib/keyboard-shortcuts"
import { SidebarActionMenu, type SidebarActionItem } from "./sidebar-actions"

interface SidebarHeaderProps {
  workspaceName: string
}

export function SidebarHeader({ workspaceName }: SidebarHeaderProps) {
  const { openSwitcher } = useQuickSwitcher()
  const { openSearch } = useSearchPanel()
  const { collapseOnMobile } = useSidebar()
  const { preferences } = usePreferences()
  const isTouch = useInputMode() === "touch"
  const [switcherMenuOpen, setSwitcherMenuOpen] = useState(false)
  const customBindings = preferences?.keyboardShortcuts ?? {}
  const streamBinding = getEffectiveKeyBinding("openQuickSwitcher", customBindings)
  const commandBinding = getEffectiveKeyBinding("openCommands", customBindings)
  const searchBinding = getEffectiveKeyBinding("openSearch", customBindings)

  const openSwitcherIn = (mode: "stream" | "command") => () => {
    collapseOnMobile()
    openSwitcher(mode)
  }

  const searchLabel = searchBinding ? `Search messages (${formatKeyBindingText(searchBinding)})` : "Search messages"

  // A keyboard hint is noise on a touch device, so the shortcut rides the
  // description line only where a keyboard is the active input.
  const switcherActions: SidebarActionItem[] = [
    {
      id: "jump-to-stream",
      label: "Jump to stream",
      icon: FileText,
      description: !isTouch && streamBinding ? formatKeyBinding(streamBinding) : null,
      onSelect: openSwitcherIn("stream"),
    },
    {
      id: "commands",
      label: "Commands",
      icon: Terminal,
      description: !isTouch && commandBinding ? formatKeyBinding(commandBinding) : null,
      onSelect: openSwitcherIn("command"),
    },
  ]

  return (
    <div className="flex-shrink-0 border-b">
      {/* Mirrors the h-12 page-header row so the sidebar toggle sits in the
           identical viewport position whether the sidebar is open or not. */}
      <div className="flex h-12 items-center gap-1 px-4">
        <SidebarToggle location="sidebar" />
        <Link
          to="/workspaces"
          className="flex min-w-0 items-center gap-2 truncate transition-opacity hover:opacity-80"
          onClick={collapseOnMobile}
        >
          <ThreaLogo size="sm" />
          <span className="truncate text-sm font-semibold">{workspaceName}</span>
        </Link>
        <div className="ml-auto flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={searchLabel}
                onClick={() => openSearch()}
              >
                <SearchIcon className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex items-center gap-2">
              <span>Search messages</span>
              {searchBinding && <ShortcutHint binding={searchBinding} />}
            </TooltipContent>
          </Tooltip>
          <SidebarActionMenu
            actions={switcherActions}
            ariaLabel="Jump to stream or command"
            side="bottom"
            align="end"
            contentClassName="w-56"
            open={switcherMenuOpen}
            onOpenChange={setSwitcherMenuOpen}
            trigger={
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Jump to stream or command">
                <Command className="h-4 w-4" />
              </Button>
            }
          />
        </div>
      </div>
    </div>
  )
}

function ShortcutHint({ binding }: { binding: string }) {
  return (
    <kbd className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
      {formatKeyBinding(binding)}
    </kbd>
  )
}
