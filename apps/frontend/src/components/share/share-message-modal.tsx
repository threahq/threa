import { useMemo, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Clock, ArrowDownAZ } from "lucide-react"
import { StreamTypes, Visibilities, type StreamType } from "@threa/types"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useWorkspaceStreams, useWorkspaceStreamMemberships, useWorkspaceUnreadState } from "@/stores/workspace-store"
import { streamLabel, STREAM_ICONS } from "@/lib/streams"
import { compareStreamEntries, scoreStreamMatch, useStoredStreamSortMode } from "@/lib/stream-sort"
import { calculateUrgency } from "@/components/layout/sidebar/utils"
import { queueShareHandoff } from "@/stores/share-handoff-store"
import { navigateAfterShareHandoff } from "@/lib/share-navigation"
import { useIsMobile } from "@/hooks/use-mobile"
import type { SharedMessageAttrs } from "@/components/editor/shared-message-extension"

const TARGET_GROUPS: { id: "channel" | "dm" | "scratchpad"; heading: string; type: StreamType }[] = [
  { id: "channel", heading: "Channels", type: StreamTypes.CHANNEL },
  { id: "dm", heading: "Direct messages", type: StreamTypes.DM },
  { id: "scratchpad", heading: "Your scratchpads", type: StreamTypes.SCRATCHPAD },
]

// Stable identity for the no-unread-state case so the streamsByGroup memo doesn't
// re-sort on every render when the workspace has no cached unread bootstrap yet.
const EMPTY_COUNTS: Record<string, number> = Object.freeze({}) as Record<string, number>

interface ShareMessageModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  attrs: SharedMessageAttrs
}

/**
 * Cross-stream picker for sharing a message as a pointer. Filters the
 * workspace's accessible top-level streams (channel / dm / scratchpad,
 * not archived) — same access semantics as backend `checkStreamAccess`.
 * On select, queues the share node for the target's composer via
 * `queueShareHandoff` and navigates; commentary + send happen in the
 * target's normal composer rather than a modal-owned editor.
 *
 * Renders through `ResponsiveDialog`, which routes to a centered Dialog
 * on desktop and a snap-pointed Drawer on mobile — same primitive the
 * quick-switcher (a sibling stream picker) uses, so the affordance stays
 * consistent. Sort order is shared with the quick-switcher via
 * `compareStreamEntries`: defaults to recency (urgency → activity time →
 * alphabetical) so the streams the user is most likely to share to bubble
 * up first, with an alphabetical toggle persisted to localStorage.
 *
 * Privacy boundaries are enforced at send time: the backend rejects with
 * `SHARE_PRIVACY_CONFIRMATION_REQUIRED` and the queue surfaces a
 * "Share anyway / Cancel" toast (`surfacePrivacyBlockToast`).
 */
export function ShareMessageModal({ open, onOpenChange, workspaceId, attrs }: ShareMessageModalProps) {
  const [search, setSearch] = useState("")
  const [sortMode, setSortMode] = useStoredStreamSortMode()
  const navigate = useNavigate()
  const location = useLocation()
  const streams = useWorkspaceStreams(workspaceId)
  const memberships = useWorkspaceStreamMemberships(workspaceId)
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const unreadCounts = unreadState?.unreadCounts ?? EMPTY_COUNTS
  const mentionCounts = unreadState?.mentionCounts ?? EMPTY_COUNTS
  const mutedStreamIds = useMemo(() => new Set(unreadState?.mutedStreamIds ?? []), [unreadState?.mutedStreamIds])
  // The Drawer/Dialog split is owned by ResponsiveDialog; isMobile here only
  // governs the post-select navigation contract (mobile strips `?panel=…`).
  const isMobile = useIsMobile()

  const memberStreamIds = useMemo(() => {
    const ids = new Set<string>()
    for (const m of memberships) ids.add(m.streamId)
    return ids
  }, [memberships])

  const streamsByGroup = useMemo(() => {
    const lower = search.toLowerCase()
    const isSearching = lower.length > 0
    const matchable = streams.filter((s) => {
      if (s.archivedAt) return false
      if (s.rootStreamId) return false
      if (s.type === StreamTypes.THREAD || s.type === StreamTypes.SYSTEM) return false
      const accessible = s.visibility === Visibilities.PUBLIC || memberStreamIds.has(s.id)
      return accessible
    })

    const enriched = matchable
      .map((stream) => {
        const score = scoreStreamMatch(stream, lower)
        const unreadCount = unreadCounts[stream.id] ?? 0
        const mentionCount = mentionCounts[stream.id] ?? 0
        const isMuted = mutedStreamIds.has(stream.id)
        const urgency = calculateUrgency(stream, unreadCount, mentionCount, isMuted)
        return { stream, score, urgency }
      })
      .filter(({ score }) => score !== Infinity)

    const byType = new Map<StreamType, typeof enriched>()
    for (const entry of enriched) {
      const list = byType.get(entry.stream.type) ?? []
      list.push(entry)
      byType.set(entry.stream.type, list)
    }
    for (const [, list] of byType) {
      list.sort((a, b) => compareStreamEntries(a, b, { isSearching, mode: sortMode }))
    }
    return byType
  }, [streams, memberStreamIds, search, sortMode, unreadCounts, mentionCounts, mutedStreamIds])

  // Wrap the parent's open-change so search resets on every close path
  // (Esc, backdrop, X, programmatic). Without this, dismissing without
  // selecting leaves the previous query in place when the modal reopens.
  // Sort mode intentionally persists across opens — it's a user preference.
  const handleOpenChange = (next: boolean) => {
    if (!next) setSearch("")
    onOpenChange(next)
  }

  const handleSelect = (targetStreamId: string) => {
    queueShareHandoff(targetStreamId, attrs)
    handleOpenChange(false)
    // Same navigation contract as the fast-path entries in
    // `message-event.tsx` — strip search params on mobile so the panel
    // doesn't shadow the parent composer, no-op when target === current.
    navigateAfterShareHandoff({ workspaceId, targetStreamId, location, navigate, isMobile })
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent
        className="overflow-hidden p-0"
        desktopClassName="sm:max-w-lg"
        // Mobile drawer keeps ResponsiveDialog's default 80%-snap full-height
        // shell; the `flex flex-col` lets the Command list claim the
        // remaining space below the header rather than overflowing.
        drawerClassName="flex flex-col"
      >
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <ResponsiveDialogTitle className="text-base">Share message</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                Pick a stream to insert this share into the composer.
              </ResponsiveDialogDescription>
            </div>
            <ToggleGroup
              type="single"
              size="sm"
              value={sortMode}
              onValueChange={(value) => {
                if (value === "recency" || value === "alphabetical") setSortMode(value)
              }}
              aria-label="Sort streams"
              className="shrink-0"
            >
              <ToggleGroupItem value="recency" aria-label="Sort by recency" title="Recent activity">
                <Clock className="h-4 w-4" aria-hidden="true" />
              </ToggleGroupItem>
              <ToggleGroupItem value="alphabetical" aria-label="Sort alphabetically" title="A–Z">
                <ArrowDownAZ className="h-4 w-4" aria-hidden="true" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </ResponsiveDialogHeader>
        <Command shouldFilter={false} className="rounded-none">
          <CommandInput placeholder="Search streams…" value={search} onValueChange={setSearch} className="border-b" />
          <CommandList className="max-h-[60vh]">
            <CommandEmpty>No matching streams.</CommandEmpty>
            {TARGET_GROUPS.map((group) => {
              const list = streamsByGroup.get(group.type)
              if (!list || list.length === 0) return null
              return (
                <CommandGroup key={group.id} heading={group.heading}>
                  {list.map(({ stream }) => {
                    const Icon = STREAM_ICONS[stream.type]
                    const label = streamLabel(stream)
                    return (
                      <CommandItem key={stream.id} value={stream.id} onSelect={() => handleSelect(stream.id)}>
                        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <span>{label}</span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
