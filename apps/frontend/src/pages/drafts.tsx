import { useState, useCallback, useMemo } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { FileText, Hash, MessageSquare, Trash2, FileEdit, ArrowLeft, Bookmark, StickyNote } from "lucide-react"
import { CompanionModes } from "@threa/types"
import { Button } from "@/components/ui/button"
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
import { ItemList, type QuickSwitcherItem } from "@/components/quick-switcher"
import { SidebarToggle } from "@/components/layout"
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

  // Handle item selection (navigate or open in new tab)
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

  return (
    <>
      <div className="flex h-full flex-col">
        <header className="flex h-12 items-center gap-2 border-b px-4">
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
        </header>
        <main
          className="flex-1 overflow-hidden"
          onKeyDown={(e) => {
            if (drafts.length === 0) return

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
                if (item) {
                  handleSelectItem(item, isMod)
                }
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
            emptyMessage="No drafts"
          />
        </main>
      </div>

      {/* Delete confirmation dialog */}
      <ResponsiveAlertDialog open={!!draftToDelete} onOpenChange={(open) => !open && handleCancelDelete()}>
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>Delete this draft?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              This action cannot be undone. The draft will be permanently deleted.
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={handleConfirmDelete}>Delete</ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  )
}
