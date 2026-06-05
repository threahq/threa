import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { Search, Terminal, FileText } from "lucide-react"
import { toast } from "sonner"
import { LabelableResourceTypes } from "@threa/types"
import { ResponsiveDialog, ResponsiveDialogContent } from "@/components/ui/responsive-dialog"
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/components/ui/responsive-alert-dialog"
import { useDraftScratchpads, useArchiveStream, useStreamName, isDraftId } from "@/hooks"
import {
  useWorkspaceUsers,
  useWorkspaceStreams,
  useWorkspaceStreamMemberships,
  useWorkspaceDmPeers,
} from "@/stores/workspace-store"
import { useIsMobile } from "@/hooks/use-mobile"
import { useSettings } from "@/contexts"
import { useUser } from "@/auth"
import { useCreateEncryptedScratchpad } from "@/hooks/use-create-encrypted-scratchpad"
import { useCreateChannel } from "@/components/create-channel"
import { useExplorerUrlState } from "@/components/attachment-explorer"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"
import { LabelPicker } from "@/components/labels/label-picker"
import { useStreamItems } from "./use-stream-items"
import { useCommandItems } from "./use-command-items"
import { useSearchItems } from "./use-search-items"
import { ItemList } from "./item-list"
import { ModeTabs } from "./mode-tabs"
import { COMMAND_TRIGGERS, RichInput, type RichInputRef, SEARCH_TRIGGERS, STREAM_TRIGGERS } from "./rich-input"
import type { CommandContext, InputRequest } from "./commands"
import type { QuickSwitcherItem } from "./types"
import { clamp } from "@/lib/math-utils"

export type QuickSwitcherMode = "stream" | "command" | "search"

interface QuickSwitcherProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  initialMode?: QuickSwitcherMode
  /** Stream currently in view (route param) — drives contextual stream commands. */
  currentStreamId?: string | null
}

const MODE_PREFIXES: Record<QuickSwitcherMode, string> = {
  stream: "",
  command: "> ",
  search: "? ",
}

const MODE_ICONS: Record<QuickSwitcherMode, React.ComponentType<{ className?: string }>> = {
  stream: FileText,
  command: Terminal,
  search: Search,
}

const MODE_PLACEHOLDERS: Record<QuickSwitcherMode, string> = {
  stream: "Search streams...",
  command: "Run a command...",
  search: "Search messages...",
}

export function deriveMode(query: string): QuickSwitcherMode {
  if (query.startsWith(">")) return "command"
  if (query.startsWith("?")) return "search"
  return "stream"
}

export function getDisplayQuery(query: string, mode: QuickSwitcherMode): string {
  if (mode === "command" && query.startsWith(">")) {
    return query.slice(1).trimStart()
  }
  if (mode === "search" && query.startsWith("?")) {
    return query.slice(1).trimStart()
  }
  return query
}

export function QuickSwitcher({ workspaceId, open, onOpenChange, initialMode, currentStreamId }: QuickSwitcherProps) {
  const navigate = useNavigate()
  const user = useUser()
  const { createDraft, deleteDraft } = useDraftScratchpads(workspaceId)
  const { openSettings } = useSettings()
  const { openCreateChannel } = useCreateChannel()
  const { open: openExplorer } = useExplorerUrlState()
  const { openStreamSettings } = useStreamSettings()
  const archiveStream = useArchiveStream(workspaceId)
  const currentStreamName = useStreamName(workspaceId, currentStreamId ?? "")

  // Destructive stream actions confirm before running; the label picker is a
  // standalone dialog opened after the palette closes. The pending-archive
  // target captures its name/draft-status at request time so the confirm copy
  // can't drift if the route (and thus `currentStreamId`) changes underneath.
  const [pendingArchive, setPendingArchive] = useState<{
    streamId: string
    name: string
    isDraft: boolean
  } | null>(null)
  const [labelPickerStreamId, setLabelPickerStreamId] = useState<string | null>(null)

  const streams = useWorkspaceStreams(workspaceId)
  const streamMemberships = useWorkspaceStreamMemberships(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)

  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null)
  const [inputValue, setInputValue] = useState("")
  const [focusedTabIndex, setFocusedTabIndex] = useState<number | null>(null)
  const [showEscapeHint, setShowEscapeHint] = useState(false)
  // Ref for synchronous access in event handlers (state updates are batched)
  const isSuggestionPopoverActiveRef = useRef(false)

  const mode = deriveMode(query)
  const displayQuery = getDisplayQuery(query, mode)
  const triggers = useMemo(() => {
    return (
      {
        stream: STREAM_TRIGGERS,
        command: COMMAND_TRIGGERS,
        search: SEARCH_TRIGGERS,
      }[mode] ?? undefined
    )
  }, [mode])

  const currentUserId = useMemo(
    () => users.find((workspaceUser) => workspaceUser.workosUserId === user?.id)?.id ?? null,
    [users, user?.id]
  )

  const isMobile = useIsMobile()
  const inputRef = useRef<HTMLInputElement>(null)
  const richInputRef = useRef<RichInputRef>(null)

  // Update ref when popover state changes (for synchronous access in event handlers)
  const handlePopoverActiveChange = useCallback((active: boolean) => {
    isSuggestionPopoverActiveRef.current = active
  }, [])

  const handleClose = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const setMode = useCallback((newMode: QuickSwitcherMode) => {
    setQuery(MODE_PREFIXES[newMode])
    setSelectedIndex(0)
  }, [])

  const requestInput = useCallback((request: InputRequest) => {
    setInputRequest(request)
    setInputValue("")
  }, [])

  const createEncryptedScratchpad = useCreateEncryptedScratchpad(workspaceId, currentUserId)

  const clearInputRequest = useCallback(() => {
    setInputRequest(null)
    setInputValue("")
  }, [])

  // Contextual stream actions close the palette first, then open their own
  // surface (settings dialog, confirm modal, label picker), which render as
  // siblings so they survive the palette unmounting its content.
  const handleOpenStreamSettings = useCallback(
    (streamId: string) => {
      handleClose()
      openStreamSettings(streamId)
    },
    [handleClose, openStreamSettings]
  )

  const requestArchiveStream = useCallback(
    (streamId: string) => {
      handleClose()
      // Contextual archive only ever targets the current stream, so its
      // resolved name is correct here — freeze it for the confirm dialog.
      setPendingArchive({
        streamId,
        name: currentStreamName ?? "this stream",
        isDraft: isDraftId(streamId),
      })
    },
    [handleClose, currentStreamName]
  )

  const openLabelPicker = useCallback(
    (streamId: string) => {
      handleClose()
      setLabelPickerStreamId(streamId)
    },
    [handleClose]
  )

  const commandContext: CommandContext = useMemo(
    () => ({
      workspaceId,
      navigate,
      closeDialog: handleClose,
      createDraftScratchpad: createDraft,
      createEncryptedScratchpad,
      openCreateChannel,
      setMode,
      requestInput,
      openSettings,
      openExplorer,
      currentStreamId,
      currentStreamName,
      openStreamSettings: handleOpenStreamSettings,
      requestArchiveStream,
      openLabelPicker,
    }),
    [
      workspaceId,
      navigate,
      handleClose,
      createDraft,
      createEncryptedScratchpad,
      openCreateChannel,
      setMode,
      requestInput,
      openSettings,
      openExplorer,
      currentStreamId,
      currentStreamName,
      handleOpenStreamSettings,
      requestArchiveStream,
      openLabelPicker,
    ]
  )

  // Get items based on current mode
  const streamResult = useStreamItems({
    workspaceId,
    query: displayQuery,
    onQueryChange: (newDisplayQuery) => setQuery(newDisplayQuery),
    navigate,
    closeDialog: handleClose,
    streams,
    streamMemberships,
    users,
    currentUserId,
    dmPeers,
  })

  const commandResult = useCommandItems({
    query: displayQuery,
    commandContext,
  })

  // Handler for search mode query changes (from filter badge removal/addition)
  const handleSearchQueryChange = useCallback((newDisplayQuery: string) => {
    setQuery(`? ${newDisplayQuery}`)
    setSelectedIndex(0)
  }, [])

  const searchResult = useSearchItems({
    workspaceId,
    query: displayQuery,
    onQueryChange: handleSearchQueryChange,
    closeDialog: handleClose,
    navigate,
    streams,
    streamMemberships,
  })

  // Select the current mode's result
  const resultByMode = { stream: streamResult, command: commandResult, search: searchResult }
  const currentResult = resultByMode[mode]
  const items = currentResult.items

  // Single source of truth for item selection (used by both Enter key and click)
  const handleSelectItem = useCallback((item: QuickSwitcherItem, withModifier: boolean) => {
    if (withModifier && item.href) {
      window.open(item.href, "_blank")
    } else {
      item.onSelect()
    }
  }, [])

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0)
  }, [items.length, mode])

  // Reset query and focus input when dialog opens
  useEffect(() => {
    if (open) {
      const prefix = initialMode ? MODE_PREFIXES[initialMode] : ""
      setQuery(prefix)
      setSelectedIndex(0)
      setFocusedTabIndex(null)
      // Skip auto-focus on mobile — opening the keyboard shifts the drawer layout
      if (!isMobile) {
        requestAnimationFrame(() => {
          richInputRef.current?.focus()
        })
      }
    }
  }, [open, initialMode, isMobile])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("")
      setSelectedIndex(0)
      setInputRequest(null)
      setInputValue("")
      setFocusedTabIndex(null)
      setShowEscapeHint(false)
    }
  }, [open])

  const dialogRef = useRef<HTMLDivElement>(null)

  // Show escape hint after 2 seconds if focus has left the dialog (Vimium scenario)
  // Only on desktop — the hint uses absolute positioning below the dialog which is
  // clipped by the mobile drawer's overflow-hidden
  useEffect(() => {
    if (!open || isMobile) return

    const timer = setTimeout(() => {
      const focusInDialog = dialogRef.current?.contains(document.activeElement)
      if (!focusInDialog) {
        setShowEscapeHint(true)
      }
    }, 2000)

    return () => clearTimeout(timer)
  }, [open, isMobile])

  const focusInput = useCallback(() => {
    setFocusedTabIndex(null)
    // Skip auto-focus on mobile — keyboard causes jarring layout shifts
    if (!isMobile) {
      requestAnimationFrame(() => {
        richInputRef.current?.focus()
      })
    }
  }, [isMobile])

  const handleModeChange = useCallback(
    (newMode: QuickSwitcherMode) => {
      if (newMode !== mode) {
        setMode(newMode)
      }
    },
    [mode, setMode]
  )

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && inputRequest) {
        e.preventDefault()
        inputRequest.onSubmit(inputValue)
        return
      }
    },
    [inputRequest, inputValue]
  )

  const handleConfirmArchive = useCallback(async () => {
    if (!pendingArchive) return
    const { streamId, isDraft } = pendingArchive
    try {
      if (isDraft) {
        await deleteDraft(streamId)
        // Drafts are fully deleted — leave the (now-gone) stream if viewing it.
        if (currentStreamId === streamId) navigate(`/w/${workspaceId}`)
        toast.success("Draft deleted")
      } else {
        await archiveStream.mutateAsync(streamId)
        toast.success("Stream archived")
      }
    } catch {
      toast.error(isDraft ? "Failed to delete draft" : "Failed to archive stream")
    } finally {
      setPendingArchive(null)
    }
  }, [pendingArchive, deleteDraft, navigate, workspaceId, currentStreamId, archiveStream])

  const archiveIsDraft = pendingArchive?.isDraft ?? false
  const archiveStreamLabel = pendingArchive?.name ?? "this stream"

  const ModeIcon = inputRequest?.icon ?? MODE_ICONS[mode]

  return (
    <>
      <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent
          ref={dialogRef}
          desktopClassName="overflow-hidden p-0 gap-0 shadow-lg sm:!fixed sm:!top-[20%] sm:!translate-y-0 sm:max-w-[600px] sm:rounded-2xl sm:border"
          drawerClassName="overflow-hidden p-0"
          hideCloseButton
          onPointerDownOutside={(e) => {
            // Prevent closing when clicking on suggestion popover (rendered via portal)
            const target = e.target as HTMLElement
            if (target.closest('[role="listbox"]')) {
              e.preventDefault()
            }
          }}
          onEscapeKeyDown={(e) => {
            // If TipTap already handled this event (closed a popover), don't close dialog
            if (e.defaultPrevented) return

            // Use ref for synchronous access (state updates are batched)
            // When suggestion popover is open, close it instead of closing dialog
            // (Radix intercepts Escape before TipTap sees it, so we close imperatively)
            if (isSuggestionPopoverActiveRef.current) {
              e.preventDefault()
              richInputRef.current?.closePopovers()
              return
            }
            // When filter select picker is open, close it instead of closing dialog
            if (currentResult.isFilterSelectActive && currentResult.closeFilterSelect) {
              e.preventDefault()
              currentResult.closeFilterSelect()
              return
            }
            // When in inputRequest mode, Escape returns to command list instead of closing
            if (inputRequest) {
              e.preventDefault()
              clearInputRequest()
              requestAnimationFrame(() => {
                richInputRef.current?.focus()
              })
            }
          }}
          onKeyDown={(e) => {
            // If TipTap already handled this event (e.g., popover keyboard nav), don't interfere
            if (e.defaultPrevented) return

            const isMod = e.metaKey || e.ctrlKey
            // Use ref for synchronous access (state updates are batched)
            // When suggestion popover is open, let TipTap handle keyboard events
            if (isSuggestionPopoverActiveRef.current) return

            // Global arrow key navigation - works even when focus is on tabs
            // Refocus input so Enter works on items (not mode tabs)
            switch (true) {
              case !inputRequest && e.key === "ArrowDown":
                e.preventDefault()
                setSelectedIndex((prev) => clamp(prev + 1, 0, items.length - 1))
                if (focusedTabIndex !== null) {
                  focusInput()
                }
                break
              case !inputRequest && e.key === "ArrowUp":
                e.preventDefault()
                setSelectedIndex((prev) => clamp(prev - 1, 0, items.length - 1))
                if (focusedTabIndex !== null) {
                  focusInput()
                }
                break
              case !inputRequest && e.key === "Enter" && focusedTabIndex === null:
                e.preventDefault()
                const item = items[selectedIndex]
                if (!item) return
                handleSelectItem(item, isMod)
                break
            }
          }}
        >
          {/* Mobile: mode tabs above the input for better hierarchy */}
          {!inputRequest && isMobile && (
            <ModeTabs
              currentMode={mode}
              onModeChange={handleModeChange}
              focusedTabIndex={focusedTabIndex}
              onFocusedTabIndexChange={setFocusedTabIndex}
              onTabSelect={focusInput}
            />
          )}

          {/* Input area */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-3 px-4 py-3 rounded-[10px] border border-border bg-background transition-all focus-within:border-primary/60 focus-within:shadow-[0_0_0_2px_hsl(var(--primary)/0.06)]">
              <ModeIcon className="h-4 w-4 shrink-0 opacity-50" />
              {inputRequest ? (
                // Plain input for command input requests (e.g., "Enter channel name")
                <input
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  placeholder={inputRequest.placeholder}
                  className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  autoFocus={!isMobile}
                  aria-label="Command input"
                />
              ) : (
                // RichInput for all modes - triggers only enabled for search mode
                <RichInput
                  ref={richInputRef}
                  value={query}
                  onChange={(value) => {
                    // Normalize the query in two steps:
                    // 1. Remove redundant prefixes: "? ? foo" → "? foo", "> > bar" → "> bar"
                    // 2. Ensure space after prefix: "?foo" → "? foo" (TipTap strips trailing whitespace)
                    const withoutRedundant = value.replace(/^([?>])\s*\1/, "$1")
                    const normalized = withoutRedundant.replace(/^([?>])(?=\S)/, "$1 ")
                    setQuery(normalized)
                    setSelectedIndex(0)
                  }}
                  onSubmit={(withModifier) => {
                    // Enter pressed with no popover open - select current item
                    const item = items[selectedIndex]
                    if (item) {
                      handleSelectItem(item, withModifier)
                    }
                  }}
                  onPopoverActiveChange={handlePopoverActiveChange}
                  triggers={triggers}
                  placeholder={MODE_PLACEHOLDERS[mode]}
                  ariaLabel={mode === "search" ? "Search query input" : "Quick switcher input"}
                  autoFocus={!isMobile}
                />
              )}
            </div>
          </div>

          {/* Desktop: mode tabs below the input (keyboard-navigable) */}
          {!inputRequest && !isMobile && (
            <ModeTabs
              currentMode={mode}
              onModeChange={handleModeChange}
              focusedTabIndex={focusedTabIndex}
              onFocusedTabIndexChange={setFocusedTabIndex}
              onTabSelect={focusInput}
            />
          )}

          {/* Hint from input request */}
          {inputRequest && (
            <div className="px-4 py-3 text-xs text-muted-foreground border-b border-border">{inputRequest.hint}</div>
          )}

          {/* Mode-specific header (e.g., search filters) */}
          {!inputRequest && currentResult.header}

          {/* Item list */}
          {!inputRequest && (
            <ItemList
              items={items}
              selectedIndex={selectedIndex}
              onSelectIndex={setSelectedIndex}
              onSelectItem={handleSelectItem}
              isLoading={currentResult.isLoading}
              emptyMessage={currentResult.emptyMessage}
            />
          )}

          {/* Keyboard hints footer — hidden on mobile (no physical keyboard) */}
          {!inputRequest && (
            <div className="hidden sm:flex items-center justify-between border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
              <div className="flex gap-4">
                <span>
                  <kbd className="kbd-hint">↑↓</kbd> Navigate
                </span>
                <span>
                  <kbd className="kbd-hint">↵</kbd> Open
                </span>
                <span>
                  <kbd className="kbd-hint">{navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}↵</kbd> New tab
                </span>
              </div>
              <span>
                <kbd className="kbd-hint">esc</kbd> Close
              </span>
            </div>
          )}

          {/* Escape hint - shown after 2s to help users with Vimium or similar */}
          {/* Uses absolute positioning to avoid layout shift (INV-21) */}
          {showEscapeHint && (
            <div className="absolute -bottom-8 left-0 right-0 text-xs text-muted-foreground/80 text-center animate-in fade-in duration-500">
              Tip: Use <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">Ctrl+[</kbd> or click outside to close
            </div>
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <ResponsiveAlertDialog
        open={pendingArchive !== null}
        onOpenChange={(next) => {
          if (!next) setPendingArchive(null)
        }}
      >
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {archiveIsDraft ? "Delete this draft?" : `Archive ${archiveStreamLabel}?`}
            </ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {archiveIsDraft
                ? "This draft will be permanently deleted. This can't be undone."
                : "This stream will be hidden from the sidebar. You can unarchive it later."}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={handleConfirmArchive}>
              {archiveIsDraft ? "Delete" : "Archive"}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>

      {labelPickerStreamId && (
        <LabelPicker
          workspaceId={workspaceId}
          resourceType={LabelableResourceTypes.STREAM}
          resourceId={labelPickerStreamId}
          open={labelPickerStreamId !== null}
          onOpenChange={(next) => {
            if (!next) setLabelPickerStreamId(null)
          }}
        />
      )}
    </>
  )
}
