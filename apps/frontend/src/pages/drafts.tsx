import { useState, useCallback, useMemo, useEffect } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import {
  FileText,
  Hash,
  MessageSquare,
  Trash2,
  FileEdit,
  ArrowLeft,
  Bookmark,
  StickyNote,
  ListChecks,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { CompanionModes } from "@threa/types"
import { Button } from "@/components/ui/button"
import { DeleteDraftConfirmDialog } from "@/components/drafts/delete-draft-confirm-dialog"
import { ItemList, type QuickSwitcherItem } from "@/components/quick-switcher"
import { SidebarToggle } from "@/components/layout"
import { cn } from "@/lib/utils"
import { useAllDrafts, type UnifiedDraft, type DraftType } from "@/hooks"

const TYPE_ICONS: Record<DraftType, React.ComponentType<{ className?: string }>> = {
  scratchpad: FileText,
  channel: Hash,
  dm: MessageSquare,
  thread: MessageSquare,
}

export function DraftsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const navigate = useNavigate()
  const { drafts, deleteDraft } = useAllDrafts(workspaceId ?? "")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [draftToDelete, setDraftToDelete] = useState<UnifiedDraft | null>(null)

  // Batch-select mode: the whole list becomes tappable toggles (desktop + mobile)
  // with a single bulk-delete action, mirroring the message timeline's selection.
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)

  // Drop selections whose draft has since disappeared (sync delete on another
  // device) so the count and select-all state stay truthful.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const valid = new Set(drafts.map((draft) => draft.id))
      const next = new Set<string>()
      for (const id of prev) if (valid.has(id)) next.add(id)
      return next.size === prev.size ? prev : next
    })
  }, [drafts])

  const handleSelectDraft = useCallback(
    (href: string | null) => {
      if (href) {
        navigate(href)
      }
    },
    [navigate]
  )

  const handleDeleteClick = useCallback((draft: UnifiedDraft) => {
    setDraftToDelete(draft)
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (draftToDelete) {
      const idToDelete = draftToDelete.id
      setDraftToDelete(null)
      await deleteDraft(idToDelete)
    }
  }, [draftToDelete, deleteDraft])

  const handleCancelDelete = useCallback(() => {
    setDraftToDelete(null)
  }, [])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const enterBatchMode = useCallback(() => setBatchMode(true), [])

  const exitBatchMode = useCallback(() => {
    setBatchMode(false)
    setSelectedIds(new Set())
  }, [])

  // Escape exits batch mode from anywhere. A document listener (not <main>'s
  // onKeyDown) so it fires no matter where focus landed — clicking the header
  // "Select" button moves focus to <body>, outside <main>'s subtree. Suspended
  // while the confirm dialog is open: Radix closes it on Escape via a
  // capture-phase preventDefault without stopPropagation, so an unguarded
  // listener here would also fire and drop the whole selection.
  useEffect(() => {
    if (!batchMode || bulkConfirmOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitBatchMode()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [batchMode, bulkConfirmOpen, exitBatchMode])

  const allSelected = drafts.length > 0 && selectedIds.size === drafts.length
  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => (prev.size === drafts.length ? new Set() : new Set(drafts.map((draft) => draft.id))))
  }, [drafts])

  const selectedCount = selectedIds.size

  const handleConfirmBulkDelete = useCallback(async () => {
    const ids = drafts.filter((draft) => selectedIds.has(draft.id)).map((draft) => draft.id)
    setBulkConfirmOpen(false)
    exitBatchMode()
    // allSettled, not a for-await loop: one failing delete must not abort the
    // rest, and the toast reports the real failed count (INV-11, fail loudly).
    const results = await Promise.allSettled(ids.map((id) => deleteDraft(id)))
    const failed = results.filter((result) => result.status === "rejected").length
    if (failed > 0) toast.error(`Failed to delete ${failed} of ${ids.length} drafts`)
  }, [drafts, selectedIds, deleteDraft, exitBatchMode])

  // Convert drafts to QuickSwitcherItem format. Stashed rows render under the
  // same per-stream `group` as their ambient-draft sibling, so the explorer
  // reads as "one section per conversation" instead of a flat dump. Stashed
  // rows surface a small bookmark icon inline (in front of the preview) so
  // they're distinguishable at a glance without stealing the stream's own
  // icon from the section header.
  const items: QuickSwitcherItem[] = useMemo(() => {
    return drafts.map((draft) => {
      let description = draft.preview
      if (draft.attachmentCount > 0) {
        const attachmentSuffix = ` [${draft.attachmentCount} 📎]`
        description = description ? `${description}${attachmentSuffix}` : attachmentSuffix
      }

      const label = draft.isStashed ? draft.preview || "Empty draft" : draft.displayName
      let icon: React.ComponentType<{ className?: string }>
      if (draft.isStashed) {
        icon = Bookmark
      } else if (draft.type === "scratchpad" && draft.companionMode === CompanionModes.OFF) {
        icon = StickyNote
      } else {
        icon = TYPE_ICONS[draft.type]
      }

      return {
        id: draft.id,
        label,
        description: draft.isStashed ? undefined : description,
        icon,
        href: draft.href ?? undefined,
        group: draft.groupLabel,
        onSelect: () => handleSelectDraft(draft.href),
        onAction: () => handleDeleteClick(draft),
        actionIcon: Trash2,
        actionLabel: "Delete draft",
      }
    })
  }, [drafts, handleSelectDraft, handleDeleteClick])

  const handleSelectItem = useCallback((item: QuickSwitcherItem, withModifier: boolean) => {
    if (withModifier && item.href) {
      window.open(item.href, "_blank")
    } else {
      item.onSelect()
    }
  }, [])

  if (!workspaceId) {
    return null
  }

  const countPill = (
    <span
      className={cn(
        "inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-medium tabular-nums tracking-tight transition-colors",
        selectedCount > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
      )}
      aria-live="polite"
    >
      {selectedCount}
    </span>
  )

  return (
    <>
      <div className="flex h-full flex-col">
        <header className="flex h-12 items-center gap-2 border-b px-4">
          {batchMode ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={exitBatchMode}
                aria-label="Cancel selection"
              >
                <X className="h-4 w-4" />
              </Button>
              {countPill}
              {/* Label hidden on phones to keep the control row from overflowing
                  narrow viewports — mirrors the timeline's BatchSelectionBar. */}
              <span className="hidden text-sm font-medium sm:inline">selected</span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={toggleSelectAll}
                  disabled={drafts.length === 0}
                >
                  {allSelected ? "Deselect all" : "Select all"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setBulkConfirmOpen(true)}
                  disabled={selectedCount === 0}
                  aria-label="Delete selected drafts"
                >
                  <Trash2 className="h-4 w-4 sm:mr-1.5" />
                  <span className="hidden sm:inline">Delete</span>
                </Button>
              </div>
            </>
          ) : (
            <>
              <SidebarToggle location="page" />
              <Link to={`/w/${workspaceId}`}>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </Link>
              <div className="flex items-center gap-2">
                <FileEdit className="h-5 w-5 text-muted-foreground" />
                <h1 className="font-semibold">Drafts</h1>
              </div>
              {drafts.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={enterBatchMode}
                  aria-label="Select drafts"
                >
                  <ListChecks className="h-4 w-4 sm:mr-1.5" />
                  <span className="hidden sm:inline">Select</span>
                </Button>
              )}
            </>
          )}
        </header>
        <main
          className="flex-1 overflow-hidden"
          onKeyDown={(e) => {
            // Batch mode is driven entirely by row focus — each option is
            // focusable and handles Enter/Space itself, so the highlight is
            // always the focused row. The page-level arrow/Enter nav below is
            // the browse-and-open model, active only when not selecting.
            if (drafts.length === 0 || batchMode) return

            const isMod = e.metaKey || e.ctrlKey

            switch (e.key) {
              case "ArrowDown":
                e.preventDefault()
                setSelectedIndex((prev) => Math.min(prev + 1, drafts.length - 1))
                break
              case "ArrowUp":
                e.preventDefault()
                setSelectedIndex((prev) => Math.max(prev - 1, 0))
                break
              case "Enter": {
                e.preventDefault()
                const item = items[selectedIndex]
                if (item) handleSelectItem(item, isMod)
                break
              }
            }
          }}
          tabIndex={0}
        >
          <ItemList
            items={items}
            selectedIndex={selectedIndex}
            onSelectIndex={setSelectedIndex}
            onSelectItem={handleSelectItem}
            selection={batchMode ? { enabled: true, selectedIds, onToggle: toggleSelect } : undefined}
            emptyMessage="No drafts"
          />
        </main>
      </div>

      <DeleteDraftConfirmDialog
        open={!!draftToDelete}
        onOpenChange={(open) => !open && handleCancelDelete()}
        onConfirm={handleConfirmDelete}
      />

      <DeleteDraftConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={setBulkConfirmOpen}
        onConfirm={handleConfirmBulkDelete}
        count={selectedCount}
      />
    </>
  )
}
