import { useState, useMemo, useCallback, useEffect } from "react"
import { useNavigate, useParams, useLocation } from "react-router-dom"
import {
  FileText,
  Hash,
  MessageSquare,
  Bell,
  Search,
  Plus,
  Link as LinkIcon,
  Image,
  Paperclip,
  Clock,
  ArrowDownAZ,
} from "lucide-react"
import { StreamTypes, getAvatarUrl } from "@threa/types"
import type { StreamType } from "@threa/types"
import {
  useWorkspaceStreams,
  useWorkspaceDmPeers,
  useWorkspaceUsers,
  useWorkspaceUnreadState,
} from "@/stores/workspace-store"
import {
  useShareTarget,
  clearShareTargetCache,
  readShareTargetFiles,
  type ShareData,
  type ShareMeta,
} from "@/hooks/use-share-target"
import { streamLabel } from "@/lib/streams"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ItemList } from "@/components/quick-switcher/item-list"
import type { QuickSwitcherItem } from "@/components/quick-switcher/types"
import { compareStreamEntries, scoreStreamMatch, useStoredStreamSortMode } from "@/lib/stream-sort"
import { calculateUrgency } from "@/components/layout/sidebar/utils"

const STREAM_ICONS: Record<StreamType, React.ComponentType<{ className?: string }>> = {
  [StreamTypes.SCRATCHPAD]: FileText,
  [StreamTypes.CHANNEL]: Hash,
  [StreamTypes.DM]: MessageSquare,
  [StreamTypes.THREAD]: MessageSquare,
  [StreamTypes.SYSTEM]: Bell,
}

const TYPE_LABELS: Partial<Record<StreamType, string>> = {
  [StreamTypes.SCRATCHPAD]: "Scratchpad",
  [StreamTypes.CHANNEL]: "Channel",
  [StreamTypes.DM]: "Direct Message",
}

// Stable identity for the no-unread-state case so the items memo doesn't
// re-sort on every render when the workspace has no cached unread bootstrap yet.
const EMPTY_COUNTS: Record<string, number> = Object.freeze({}) as Record<string, number>

/**
 * Share destination picker — workspace-scoped page shown when content is shared to Threa.
 *
 * Displays a searchable stream list so the user can choose where to place the shared content.
 * A "New scratchpad" option is always available at the top.
 */
export function SharePickerPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const idbStreams = useWorkspaceStreams(workspaceId!)
  const idbDmPeers = useWorkspaceDmPeers(workspaceId!)
  const idbUsers = useWorkspaceUsers(workspaceId!)
  const unreadState = useWorkspaceUnreadState(workspaceId!)
  const unreadCounts = unreadState?.unreadCounts ?? EMPTY_COUNTS
  const mentionCounts = unreadState?.mentionCounts ?? EMPTY_COUNTS
  const activityCounts = unreadState?.activityCounts ?? EMPTY_COUNTS
  const mutedStreamIds = useMemo(() => new Set(unreadState?.mutedStreamIds ?? []), [unreadState?.mutedStreamIds])
  const { createShareDraft, saveShareContent } = useShareTarget()

  const [query, setQuery] = useState("")
  const [sortMode, setSortMode] = useStoredStreamSortMode()
  const [selectedIndex, setSelectedIndex] = useState(0)
  // null = not yet loaded, [] = loaded but empty/unavailable
  const [files, setFiles] = useState<File[] | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Only lightweight text metadata comes from navigation state — files stay in Cache API
  // to avoid hitting browser history.state serialization limits (~640 KB in Firefox).
  const shareMeta: ShareMeta = useMemo(() => {
    const state = location.state as { shareMeta?: ShareMeta | null } | null
    return state?.shareMeta ?? { title: null, text: null, url: null, hasFiles: false }
  }, [location.state])

  const { title, text, url, hasFiles } = shareMeta

  // Read file blobs from the Cache API on mount (not from navigation state)
  useEffect(() => {
    if (!hasFiles) return
    let cancelled = false
    readShareTargetFiles().then((f) => {
      if (!cancelled) setFiles(f)
    })
    return () => {
      cancelled = true
    }
  }, [hasFiles])

  const filesLoading = hasFiles && files === null
  const resolvedFiles = files ?? []

  // Full ShareData for passing to handlers (combines meta + files)
  const shareData: ShareData = useMemo(
    () => ({ title, text, url, files: resolvedFiles }),
    [title, text, url, resolvedFiles]
  )

  // Build a preview of what's being shared
  const sharedPreview = useMemo(() => {
    const parts: string[] = []
    if (title) parts.push(title)
    if (text && text !== title) parts.push(text)
    if (url) parts.push(url)
    return parts.join(" — ") || null
  }, [title, text, url])

  const filesSummary = useMemo(() => {
    if (!hasFiles) return null
    // files === null means the effect hasn't resolved yet
    if (files === null) return "Loading files..."
    if (files.length === 0) return null
    const imageCount = files.filter((f) => f.type.startsWith("image/")).length
    const otherCount = files.length - imageCount
    const parts: string[] = []
    if (imageCount > 0) parts.push(`${imageCount} image${imageCount > 1 ? "s" : ""}`)
    if (otherCount > 0) parts.push(`${otherCount} file${otherCount > 1 ? "s" : ""}`)
    return parts.join(", ")
  }, [hasFiles, files])

  const streams = idbStreams
  const dmPeers = idbDmPeers
  const users = idbUsers

  const handleSelectStream = useCallback(
    async (streamId: string) => {
      if (filesLoading || submitting) return
      setSubmitting(true)
      try {
        await saveShareContent(workspaceId!, streamId, shareData)
      } catch (err) {
        // Navigate anyway — the draft won't be pre-populated but the user isn't stranded
        console.error("Failed to save shared content", err)
      }
      void clearShareTargetCache()
      navigate(`/w/${workspaceId}/s/${streamId}`, { replace: true })
    },
    [workspaceId, shareData, navigate, saveShareContent, filesLoading, submitting]
  )

  const handleNewScratchpad = useCallback(async () => {
    if (filesLoading || submitting) return
    setSubmitting(true)
    try {
      const result = await createShareDraft(workspaceId!, shareData)
      void clearShareTargetCache()
      navigate(result.path, { replace: true })
    } catch (err) {
      console.error("Failed to create share draft", err)
      navigate(`/w/${workspaceId}`, { replace: true })
    }
  }, [workspaceId, shareData, navigate, createShareDraft, filesLoading, submitting])

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const items = useMemo(() => {
    const lowerQuery = query.toLowerCase()
    const dmPeerByStreamId = new Map(dmPeers.map((peer) => [peer.streamId, peer.userId]))
    const usersById = new Map(users.map((u) => [u.id, u]))

    // "New scratchpad" always at the top
    const newScratchpadItem: QuickSwitcherItem = {
      id: "__new_scratchpad__",
      label: "New scratchpad",
      icon: Plus,
      description: "Create a new scratchpad with shared content",
      onSelect: handleNewScratchpad,
    }

    // Filter to navigable stream types
    const filteredStreams = streams.filter(
      (s) =>
        s.archivedAt == null &&
        (s.type === StreamTypes.SCRATCHPAD || s.type === StreamTypes.CHANNEL || s.type === StreamTypes.DM)
    )

    const isSearching = lowerQuery.length > 0
    const streamItems = filteredStreams
      .map((stream) => {
        const score = scoreStreamMatch(stream, lowerQuery)
        const unreadCount = unreadCounts[stream.id] ?? 0
        const mentionCount = mentionCounts[stream.id] ?? 0
        const activityCount = activityCounts[stream.id] ?? 0
        const isMuted = mutedStreamIds.has(stream.id)
        const urgency = calculateUrgency(stream, unreadCount, mentionCount, isMuted, activityCount)
        return { stream, score, urgency, unreadCount, mentionCount }
      })
      .filter(({ score }) => score !== Infinity)
      .sort((a, b) => compareStreamEntries(a, b, { isSearching, mode: sortMode }))
      .map(({ stream, urgency, unreadCount, mentionCount }): QuickSwitcherItem => {
        let avatarUrl: string | undefined
        if (stream.type === StreamTypes.DM) {
          const peerUserId = dmPeerByStreamId.get(stream.id)
          const peerUser = peerUserId ? usersById.get(peerUserId) : undefined
          avatarUrl = getAvatarUrl(workspaceId!, peerUser?.avatarUrl, 64)
        }

        const typeLabel = TYPE_LABELS[stream.type] ?? stream.type

        return {
          id: stream.id,
          label: streamLabel(stream),
          description: typeLabel,
          icon: STREAM_ICONS[stream.type],
          avatarUrl,
          urgency,
          unreadCount,
          mentionCount,
          onSelect: () => handleSelectStream(stream.id),
        }
      })

    return [newScratchpadItem, ...streamItems]
  }, [
    streams,
    dmPeers,
    users,
    query,
    sortMode,
    workspaceId,
    handleNewScratchpad,
    handleSelectStream,
    unreadCounts,
    mentionCounts,
    activityCounts,
    mutedStreamIds,
  ])

  const isLoading = filesLoading || submitting

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="w-full max-w-lg flex flex-col max-h-[80dvh]">
        {/* Header */}
        <div className="px-4 pt-6 pb-4">
          <h1 className="text-lg font-medium">Share to Threa</h1>

          {/* Text preview */}
          {sharedPreview && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
              <LinkIcon className="h-4 w-4 shrink-0 mt-0.5 opacity-60" />
              <span className="line-clamp-2 break-all">{sharedPreview}</span>
            </div>
          )}

          {/* File preview */}
          {filesSummary && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
              {resolvedFiles.some((f) => f.type.startsWith("image/")) ? (
                <Image className="h-4 w-4 shrink-0 mt-0.5 opacity-60" />
              ) : (
                <Paperclip className="h-4 w-4 shrink-0 mt-0.5 opacity-60" />
              )}
              <span>{filesSummary}</span>
            </div>
          )}
        </div>

        {/* Search */}
        <div className="px-4 pb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search streams..."
              className="pl-9"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault()
                  setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1))
                } else if (e.key === "ArrowUp") {
                  e.preventDefault()
                  setSelectedIndex((prev) => Math.max(prev - 1, 0))
                } else if (e.key === "Enter") {
                  e.preventDefault()
                  const item = items[selectedIndex]
                  if (item) item.onSelect()
                }
              }}
            />
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

        {/* Stream list */}
        <div className="flex-1 min-h-0 overflow-y-auto border-t border-border">
          <ItemList
            items={items}
            selectedIndex={selectedIndex}
            onSelectIndex={setSelectedIndex}
            onSelectItem={(item) => item.onSelect()}
            isLoading={isLoading}
            emptyMessage="No streams found."
          />
        </div>
      </div>
    </div>
  )
}
