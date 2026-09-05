import { useState } from "react"
import { ChevronDown, FileText, Search as SearchIcon, Terminal } from "lucide-react"
import { Link } from "react-router-dom"
import { useQuickSwitcher, usePreferences, useSidebar } from "@/contexts"
import { useSearchPanel } from "@/components/search/search-panel-context"
import { useInputMode } from "@/hooks/use-input-mode"
import { cn } from "@/lib/utils"
import { ThreaLogo } from "@/components/threa-logo"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SidebarToggle } from "@/components/layout/sidebar-toggle"
import { getEffectiveKeyBinding, formatKeyBinding, formatKeyBindingText } from "@/lib/keyboard-shortcuts"
import { SidebarActionDrawer, SidebarActionMenu, type SidebarActionItem } from "./sidebar-actions"

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
    <div className="flex-shrink-0">
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
        </div>
      </div>

      {/* The hairline under the header runs into the quick-switch tab and stops
           there; the tab hangs below the line, carved out of the header. */}
      <div className="flex h-[18px] items-start">
        <div className="h-px flex-1 bg-border" />
        <SwitcherNotch
          actions={switcherActions}
          isTouch={isTouch}
          open={switcherMenuOpen}
          onOpenChange={setSwitcherMenuOpen}
        />
        <div className="h-px w-2 bg-border" />
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

const NOTCH_CLASS = cn(
  // Pulled up into the header row's slack so the tab reads 24px tall while
  // costing 18px of vertical space; `after` widens the touch target downward
  // without moving anything (INV-21).
  "-mt-1.5 relative flex h-6 w-11 items-center justify-center rounded-b-lg border-x border-b border-border bg-background",
  "text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
  "after:absolute after:-inset-x-1.5 after:-bottom-2.5 after:top-0 after:content-['']",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "data-[state=open]:bg-muted/60 data-[state=open]:text-foreground"
)

/**
 * The tab hanging off the header's bottom-right edge. Opens the two quick-switch
 * surfaces (stream jump, commands) as a drawer on touch and a dropdown for mouse
 * input, mirroring the account and create menus in the footer. Top-level per INV-18.
 */
function SwitcherNotch({
  actions,
  isTouch,
  open,
  onOpenChange,
}: {
  actions: SidebarActionItem[]
  isTouch: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const face = <ChevronDown className="h-3.5 w-3.5" />

  if (isTouch) {
    return (
      <>
        <button
          type="button"
          className={NOTCH_CLASS}
          data-state={open ? "open" : "closed"}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Jump to stream or command"
          onClick={() => onOpenChange(true)}
        >
          {face}
        </button>
        <SidebarActionDrawer
          open={open}
          onOpenChange={onOpenChange}
          actions={actions}
          title="Jump to"
          description="Open stream search or the command palette."
        />
      </>
    )
  }

  return (
    <SidebarActionMenu
      actions={actions}
      ariaLabel="Jump to stream or command"
      side="bottom"
      align="end"
      contentClassName="w-56"
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <button type="button" className={NOTCH_CLASS} aria-label="Jump to stream or command">
          {face}
        </button>
      }
    />
  )
}
