import { useCallback, useMemo, useState } from "react"
import { FileEdit, FilePlus, Trash2 } from "lucide-react"
import { serializeToMarkdown } from "@threa/prosemirror"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { stripMarkdownToInline } from "@/lib/markdown"
import { formatRelativeTime } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import type { CachedDraft } from "@/hooks"

/** Keystroke hint for the "Save current" action. Rendered only on non-mobile (no hardware keyboard). */
const MOD_SYMBOL = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl+"

interface StashedDraftsPickerProps {
  drafts: CachedDraft[]
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

function getPreview(draft: CachedDraft): string {
  try {
    const md = serializeToMarkdown(draft.contentJson)
    const stripped = stripMarkdownToInline(md).trim()
    if (stripped.length > 0) return stripped
  } catch {
    // Fall through to attachment-only label below.
  }
  const attachmentCount = draft.attachments?.length ?? 0
  if (attachmentCount > 0) {
    return `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
  }
  return "Empty draft"
}

export function StashedDraftsPicker({
  drafts,
  canStashCurrent,
  onStashCurrent,
  onRestore,
  onDelete,
  controlsDisabled = false,
  size = "compact",
}: StashedDraftsPickerProps) {
  const [open, setOpen] = useState(false)
  const isMobile = useIsMobile()
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

  const handleDelete = useCallback(
    (id: string) => {
      onDelete(id)
    },
    [onDelete]
  )

  const triggerSizeClass = size === "fab" ? "h-[30px] w-[30px] rounded-md bg-background shadow-md" : "h-7 w-7"
  const triggerIconClass = size === "fab" ? "h-4 w-4" : "h-3.5 w-3.5"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
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

      <PopoverContent align="end" side="top" className="w-80 p-0">
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
            {!isMobile && <span className="text-muted-foreground ml-1">{MOD_SYMBOL}S</span>}
          </Button>
        </div>

        {drafts.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {isMobile ? (
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
              const preview = getPreview(draft)
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
                        handleDelete(draft.id)
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
  )
}
