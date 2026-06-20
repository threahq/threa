import { useCallback, useMemo, useState } from "react"
import { FileEdit, FilePlus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DeleteDraftConfirmDialog } from "@/components/drafts/delete-draft-confirm-dialog"
import { draftInlineText, draftPreviewStatusLabel } from "@/lib/drafts/decryption"
import { formatRelativeTime } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { useCoarsePointer } from "@/hooks/use-pointer"
import { keepEditorFocusProps } from "@/lib/keep-editor-focus"
import { useComposerAnchor } from "./use-composer-anchor"
import type { CachedDraft, DraftPreview } from "@/hooks"

/** Keystroke hint for the "Save current" action. Rendered only for fine pointers (no hardware keyboard on touch). */
const MOD_SYMBOL = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl+"

interface StashedDraftsPickerProps {
  drafts: CachedDraft[]
  /**
   * Decrypted (or plaintext) inline previews per draft id, computed by the host
   * via `useDecryptedDraftPreviews`. The picker stays presentational — it never
   * touches the decrypt cache or session itself. Absent → previews fall back to
   * the row's `contentJson` (plaintext-only callers / tests).
   */
  previewById?: Map<string, DraftPreview>
  /** True when the composer has something worth stashing (controls "Save current" enablement). */
  canStashCurrent: boolean
  /** Called when the user clicks "Save current draft" or presses Enter on the save affordance. */
  onStashCurrent: () => void
  /** Called with the stashed draft id when the user clicks a row to restore it. */
  onRestore: (id: string) => void
  /** Called when the user clicks the trash icon on a row. */
  onDelete: (id: string) => void
  /** When `controlsDisabled`, the trigger button is disabled (e.g. composer is sending). */
  controlsDisabled?: boolean
  /**
   * Visual size of the trigger button. `compact` matches the 7x7 toolbar row on
   * desktop inline; `fab` matches the 30x30 floating drawer in expanded mode.
   */
  size?: "compact" | "fab"
}

function attachmentOrEmptyLabel(draft: CachedDraft): string {
  const attachmentCount = draft.attachments?.length ?? 0
  if (attachmentCount > 0) {
    return `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
  }
  return "Empty draft"
}

/**
 * The row label: the host-supplied decrypted preview when present (E2E + plaintext
 * alike), otherwise derived from `contentJson` for plaintext-only callers/tests.
 * A sealed draft mid-decrypt / locked / failed gets a status label instead of a
 * blank row.
 */
function rowPreview(draft: CachedDraft, previewById?: Map<string, DraftPreview>): string {
  const preview = previewById?.get(draft.id)
  if (!preview) return draftInlineText(draft.contentJson) || attachmentOrEmptyLabel(draft)
  if (preview.status !== "ready") return draftPreviewStatusLabel(preview.status)
  return preview.text || attachmentOrEmptyLabel(draft)
}

export function StashedDraftsPicker({
  drafts,
  previewById,
  canStashCurrent,
  onStashCurrent,
  onRestore,
  onDelete,
  controlsDisabled = false,
  size = "compact",
}: StashedDraftsPickerProps) {
  const [open, setOpen] = useState(false)
  const [draftToDelete, setDraftToDelete] = useState<string | null>(null)
  const { setTriggerRef, anchor } = useComposerAnchor(open)
  const isTouch = useCoarsePointer()
  const count = drafts.length
  const now = useMemo(() => new Date(), [open])

  const handleStashCurrent = useCallback(() => {
    onStashCurrent()
    // Keep the popover open so the user sees their draft land in the list —
    // feels more affirmative than a silent close. Closing on restore is
    // handled inside the row handler below.
  }, [onStashCurrent])

  const handleRestore = useCallback(
    (id: string) => {
      onRestore(id)
      setOpen(false)
    },
    [onRestore]
  )

  // Two-step delete: the trash icon opens a confirm dialog (parity with the
  // Drafts explorer — a draft is a draft, so both surfaces guard a delete the
  // same way). Close the popover first so the modal isn't trapped behind it. No
  // success toast by design: the confirm already makes the delete deliberate.
  const requestDelete = useCallback((id: string) => {
    setOpen(false)
    setDraftToDelete(id)
  }, [])

  const confirmDelete = useCallback(() => {
    if (draftToDelete) onDelete(draftToDelete)
    setDraftToDelete(null)
  }, [draftToDelete, onDelete])

  const triggerSizeClass = size === "fab" ? "h-[30px] w-[30px] rounded-md bg-background shadow-md" : "h-7 w-7"
  const triggerIconClass = size === "fab" ? "h-4 w-4" : "h-3.5 w-3.5"

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        {/* Anchor above the whole composer (not the trigger) so the popover
            doesn't paint over the editor — null in the expanded FAB layout,
            where the trigger anchors normally. */}
        {anchor && <PopoverAnchor virtualRef={{ current: anchor }} />}
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                ref={setTriggerRef}
                type="button"
                variant={size === "fab" ? "outline" : "ghost"}
                size="icon"
                aria-label={count > 0 ? `Drafts (${count} saved)` : "Drafts"}
                className={cn("relative shrink-0 p-0", triggerSizeClass)}
                disabled={controlsDisabled}
                onPointerDown={size === "fab" ? (e) => e.preventDefault() : undefined}
              >
                <FileEdit className={triggerIconClass} />
                {count > 0 && (
                  // Subtle presence dot — signals "there's something here" without
                  // demanding attention the way a colored number badge does. The
                  // actual count lives inside the popover header.
                  <span
                    className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-muted-foreground/60 pointer-events-none"
                    aria-hidden
                  />
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Drafts
          </TooltipContent>
        </Tooltip>

        <PopoverContent align="end" side="top" sideOffset={8} className="w-80 p-0" {...keepEditorFocusProps(isTouch)}>
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
            <p className="text-sm font-medium">
              Drafts
              {count > 0 && <span className="text-muted-foreground font-normal ml-1.5">({count})</span>}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1 text-xs"
              onClick={handleStashCurrent}
              disabled={!canStashCurrent}
            >
              <FilePlus className="h-3.5 w-3.5" />
              <span>Save current</span>
              {!isTouch && <span className="text-muted-foreground ml-1">{MOD_SYMBOL}S</span>}
            </Button>
          </div>

          {drafts.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {isTouch ? (
                <>No saved drafts yet. Tap "Save current" to stash what you're typing and start fresh.</>
              ) : (
                <>
                  No saved drafts yet. Press <span className="font-medium text-foreground">{MOD_SYMBOL}S</span> to stash
                  what you're typing and start fresh.
                </>
              )}
            </div>
          ) : (
            <ul className="max-h-64 overflow-y-auto py-1" role="list">
              {drafts.map((draft) => {
                const preview = rowPreview(draft, previewById)
                const attachmentCount = draft.attachments?.length ?? 0
                return (
                  <li key={draft.id} className="group/row">
                    <div className="flex items-start gap-2 px-3 py-2 hover:bg-muted/60 focus-within:bg-muted/60">
                      <button
                        type="button"
                        onClick={() => handleRestore(draft.id)}
                        className="flex-1 min-w-0 text-left focus:outline-none"
                      >
                        <p className="text-sm line-clamp-2 break-words">{preview}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {formatRelativeTime(new Date(draft.clientUpdatedAt), now, undefined, { terse: true })}
                          {attachmentCount > 0 && <span className="ml-1.5">· {attachmentCount} 📎</span>}
                        </p>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Delete saved draft"
                        className="h-7 w-7 shrink-0 opacity-0 group-hover/row:opacity-100 focus:opacity-100 max-sm:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation()
                          requestDelete(draft.id)
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </PopoverContent>
      </Popover>

      <DeleteDraftConfirmDialog
        open={draftToDelete !== null}
        onOpenChange={(o) => !o && setDraftToDelete(null)}
        onConfirm={confirmDelete}
      />
    </>
  )
}
