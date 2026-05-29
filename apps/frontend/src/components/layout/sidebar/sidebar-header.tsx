import { Search as SearchIcon, Terminal, FileText, SlidersHorizontal } from "lucide-react"
import { Link } from "react-router-dom"
import { useQuickSwitcher, usePreferences } from "@/contexts"
import { useSidebar } from "@/contexts"
import { cn } from "@/lib/utils"
import { ThemeDropdown } from "@/components/theme-dropdown"
import { ThreaLogo } from "@/components/threa-logo"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SidebarToggle } from "@/components/layout/sidebar-toggle"
import { getEffectiveKeyBinding, formatKeyBinding, formatKeyBindingText } from "@/lib/keyboard-shortcuts"

interface SidebarHeaderProps {
  workspaceName: string
  /** Open the sidebar customization panel (presets, quick links, sections). */
  onEditLayout: () => void
  /** Hide the customize control (e.g., when no streams exist) */
  hideViewToggle?: boolean
}

export function SidebarHeader({ workspaceName, onEditLayout, hideViewToggle }: SidebarHeaderProps) {
  const { openSwitcher } = useQuickSwitcher()
  const { collapseOnMobile } = useSidebar()
  const { preferences } = usePreferences()
  const customBindings = preferences?.keyboardShortcuts ?? {}
  const streamBinding = getEffectiveKeyBinding("openQuickSwitcher", customBindings)
  const commandBinding = getEffectiveKeyBinding("openCommands", customBindings)
  const searchBinding = getEffectiveKeyBinding("openSearch", customBindings)

  const handleOpenSwitcher = (mode: "stream" | "command" | "search") => () => {
    collapseOnMobile()
    openSwitcher(mode)
  }

  return (
    <div className="flex-shrink-0 border-b">
      {/* Top row — mirrors the h-12 page-header row so the sidebar toggle sits
           in the identical viewport position whether the sidebar is open or not. */}
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
          <ThemeDropdown />
        </div>
      </div>

      {/* Quick-action pills — replaces the former full-width search box. The
           three affordances (stream / command palette / message search) are the
           entry points to the three quick-switcher modes. */}
      <div className="flex items-center gap-1 px-3 pt-2">
        <QuickActionPill
          onClick={handleOpenSwitcher("stream")}
          icon={FileText}
          label="Jump to stream"
          binding={streamBinding}
        />
        <QuickActionPill
          onClick={handleOpenSwitcher("command")}
          icon={Terminal}
          label="Commands"
          binding={commandBinding}
        />
        <QuickActionPill
          onClick={handleOpenSwitcher("search")}
          icon={SearchIcon}
          label="Search messages"
          binding={searchBinding}
        />
      </div>

      {/* Customize control — hidden when there are no streams. Presets,
           quick-link visibility, and section order all live in the panel it opens. */}
      {!hideViewToggle && (
        <div className="flex items-center px-3 pb-3 pt-2">
          <button
            type="button"
            onClick={onEditLayout}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Customize sidebar
          </button>
        </div>
      )}

      {/* When the customize control is hidden we still need trailing breathing
           room under the pill row so the list below doesn't butt against the border. */}
      {hideViewToggle && <div className="h-3" aria-hidden="true" />}
    </div>
  )
}

interface QuickActionPillProps {
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  /** Effective user-configured binding, e.g. "mod+k"; undefined if disabled. */
  binding: string | undefined
}

function QuickActionPill({ onClick, icon: Icon, label, binding }: QuickActionPillProps) {
  const shortcutLabel = binding ? formatKeyBinding(binding) : null
  const ariaLabel = binding ? `${label} (${formatKeyBindingText(binding)})` : label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          className={cn(
            "flex h-8 flex-1 items-center justify-center rounded-md border border-border bg-background",
            "text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2">
        <span>{label}</span>
        {shortcutLabel && (
          <kbd className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
            {shortcutLabel}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
