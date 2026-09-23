import {
  ArrowLeft,
  ArrowRight,
  Command,
  Compass,
  FileText,
  History,
  Search as SearchIcon,
  Terminal,
} from "lucide-react"
import { Link } from "react-router-dom"
import { useQuickSwitcher, usePreferences, useSidebar } from "@/contexts"
import { useSearchPanel } from "@/components/search/search-panel-context"
import { useInputMode } from "@/hooks/use-input-mode"
import { ThreaLogo } from "@/components/threa-logo"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SidebarToggle } from "@/components/layout/sidebar-toggle"
import { useNavigationJournal, type JournalStep } from "@/hooks"
import { formatRelativeTime } from "@/lib/dates"
import { resolveStreamName, STREAM_ICONS } from "@/lib/streams"
import { useWorkspaceDmPeers, useWorkspaceStreams, useWorkspaceUsers } from "@/stores/workspace-store"
import { getEffectiveKeyBinding, formatKeyBinding, formatKeyBindingText } from "@/lib/keyboard-shortcuts"
import { SidebarActionMenu, type SidebarActionItem } from "./sidebar-actions"

interface SidebarHeaderProps {
  workspaceName: string
  workspaceId: string
}

export function SidebarHeader({ workspaceName, workspaceId }: SidebarHeaderProps) {
  const { openSwitcher } = useQuickSwitcher()
  const { openSearch } = useSearchPanel()
  const { collapseOnMobile } = useSidebar()
  const { preferences } = usePreferences()
  const isTouch = useInputMode() === "touch"
  const customBindings = preferences?.keyboardShortcuts ?? {}
  const streamBinding = getEffectiveKeyBinding("openQuickSwitcher", customBindings)
  const commandBinding = getEffectiveKeyBinding("openCommands", customBindings)
  const searchBinding = getEffectiveKeyBinding("openSearch", customBindings)
  const backBinding = getEffectiveKeyBinding("historyBack", customBindings)
  const forwardBinding = getEffectiveKeyBinding("historyForward", customBindings)
  const { back, forward, recent, step } = useNavigationJournal(workspaceId)
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)

  const onStep = (target: JournalStep) => {
    step(target)
    collapseOnMobile()
  }

  const now = new Date()
  // The journal outlives the streams cache: a deleted or not-yet-hydrated
  // stream has no name to show and no page to open, so its row is skipped.
  const recentActions: SidebarActionItem[] = recent.flatMap((entry) => {
    const label = resolveStreamName(entry.streamId, { streams, users, dmPeers }, "sidebar")
    if (!label) return []
    return {
      id: entry.streamId,
      href: entry.href,
      label,
      icon: STREAM_ICONS[streams.find((stream) => stream.id === entry.streamId)?.type ?? "channel"],
      description: formatRelativeTime(new Date(entry.at), now, undefined, { terse: true }),
      onSelect: collapseOnMobile,
    }
  })
  if (recentActions[0]) recentActions[0].separatorBefore = true

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
    {
      id: "browse-streams",
      label: "Browse streams",
      icon: Compass,
      href: `/w/${workspaceId}/streams`,
      onSelect: collapseOnMobile,
    },
  ]

  return (
    // Mirrors the h-12 page-header row so the sidebar toggle sits in the
    // identical viewport position whether the sidebar is open or not.
    <div className="flex h-12 flex-shrink-0 items-center gap-1 border-b px-4">
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
        <SidebarActionMenu
          actions={recentActions}
          side="bottom"
          align="end"
          contentClassName="w-64"
          header={
            <div className="flex items-center gap-1">
              <HistoryStep
                direction="back"
                target={back}
                binding={!isTouch ? backBinding : undefined}
                onNavigate={onStep}
              />
              <HistoryStep
                direction="forward"
                target={forward}
                binding={!isTouch ? forwardBinding : undefined}
                onNavigate={onStep}
              />
            </div>
          }
          trigger={
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="History">
              <History className="h-4 w-4" />
            </Button>
          }
        />
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
          side="bottom"
          align="end"
          contentClassName="w-56"
          trigger={
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Jump to stream or command">
              <Command className="h-4 w-4" />
            </Button>
          }
        />
      </div>
    </div>
  )
}

function HistoryStep({
  direction,
  target,
  binding,
  onNavigate,
}: {
  direction: "back" | "forward"
  target: JournalStep | null
  binding: string | undefined
  onNavigate: (target: JournalStep) => void
}) {
  const label = direction === "back" ? "Back" : "Forward"
  const Icon = direction === "back" ? ArrowLeft : ArrowRight
  const content = (
    <>
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
      {binding && <ShortcutHint binding={binding} />}
    </>
  )

  if (!target) {
    return (
      <DropdownMenuItem className="flex-1 gap-1.5" disabled>
        {content}
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenuItem asChild className="flex-1 cursor-pointer gap-1.5">
      <Link
        to={target.to}
        state={target.state}
        onClick={(event) => {
          // A modified or non-primary click opens another tab: this tab's cursor stays.
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          onNavigate(target)
        }}
      >
        {content}
      </Link>
    </DropdownMenuItem>
  )
}

function ShortcutHint({ binding }: { binding: string }) {
  return (
    <kbd className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
      {formatKeyBinding(binding)}
    </kbd>
  )
}
