import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { FileEdit, FilePlus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DeleteDraftConfirmDialog } from "@/components/drafts/delete-draft-confirm-dialog"
import { draftInlineText, draftPreviewStatusLabel } from "@/lib/drafts/decryption"
import { formatRelativeTime } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { useInputMode } from "@/hooks/use-input-mode"
import { composerPopoverAlign, useComposerActionSide } from "@/hooks/use-composer-action-side"
import { keepEditorFocusProps } from "@/lib/keep-editor-focus"
import { usePreferencesOptional } from "@/contexts"
import { formatKeyBinding, getEffectiveKeyBinding } from "@/lib/keyboard-shortcuts"
import { useFabDrawerClose } from "./fab-drawer-close-context"
import { useRegisterStashedDraftsOpen, useStashedDraftsBridge } from "./stashed-drafts-open-context"
import { useComposerAnchor } from "./use-composer-anchor"
import type { CachedDraft, DraftPreview, StashedDraftRowOrigin } from "@/hooks"
import { RESTORE_REFUSAL_MESSAGE, type DraftRestoreResult } from "@/lib/drafts/restore-refusal"

interface StashedDraftsPickerProps {
  drafts: CachedDraft[]
  /**
   * Decrypted (or plaintext) inline previews per draft id, computed by the host
   * via `useDecryptedDraftPreviews`. The picker stays presentational — it never
   * touches the decrypt cache or session itself. Absent → previews fall back to
   * the row's `contentJson` (plaintext-only callers / tests).
   */
  previewById?: Map<string, DraftPreview>
  /**
   * Per-row tier + already-formatted origin label, from `useStashedDraftOrigins`.
   * The picker only renders it: it draws the own/borrowed seam and names where a
   * borrowed row came from, and never resolves a stream, conversation or scope
   * itself (INV-15). Absent → every row renders as its own (plaintext-only
   * callers / tests).
   */
  originById?: Map<string, StashedDraftRowOrigin>
  /** True when the composer has something worth stashing (controls "Save current" enablement). */
  canStashCurrent: boolean
  /** Called when the user clicks "Save current draft" or presses Enter on the save affordance. */
  onStashCurrent: () => void
  /**
   * Called with the stashed draft id when the user clicks a row to restore it.
   * A refusal comes back as `{ ok: false }` rather than throwing; the picker
   * stays open and says why, because closing + focusing the composer on a
   * no-op reads as success (INV-63).
   */
  onRestore: (id: string) => void | Promise<DraftRestoreResult | void>
  /** Called when the user clicks the trash icon on a row. */
  onDelete: (id: string) => void
  /**
   * Called when the popover opens/closes. The host latches pile membership while
   * it is open, so a row can't vanish mid-pick when its landing stream moves.
   */
  onOpenChange?: (open: boolean) => void
  /** When `controlsDisabled`, the trigger button is disabled (e.g. composer is sending). */
  controlsDisabled?: boolean
  /**
   * Visual size of the trigger button. `compact` matches the 7x7 toolbar row on
   * desktop inline; `fab` matches the 30x30 floating drawer in expanded mode.
   */
  size?: "compact" | "fab"
}

/**
 * What a refused restore tells the user. Every reason is a state the pile was
 * showing a render ago and the world has since moved past, so the copy names
 * what happened to the draft, not what the code checked.
 */
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
  originById,
  canStashCurrent,
  onStashCurrent,
  onRestore,
  onDelete,
  onOpenChange,
  controlsDisabled = false,
  size = "compact",
}: StashedDraftsPickerProps) {
  const [open, setOpen] = useState(false)
  useEffect(() => onOpenChange?.(open), [open, onOpenChange])
  const [draftToDelete, setDraftToDelete] = useState<string | null>(null)
  const closeFabDrawer = useFabDrawerClose()
  const bridge = useStashedDraftsBridge()
  const { setTriggerRef, anchor } = useComposerAnchor(open)
  const contentRef = useRef<HTMLDivElement>(null)
  // Set when a restore closes the popover: Radix's close-autofocus (back to
  // the trigger) is suppressed so focus can follow the restored content into
  // the editor instead.
  const suppressCloseFocusRef = useRef(false)

  // Cmd/Ctrl+S on an empty composer opens the list (registered with the
  // hosting MessageComposer via the bridge).
  const openFromShortcut = useCallback(() => setOpen(true), [])
  useRegisterStashedDraftsOpen(openFromShortcut)

  // The stash shortcut hint mirrors the user's effective (remappable)
  // `draftStash` binding rather than a hardcoded ⌘S.
  const keyboardShortcuts = usePreferencesOptional()?.preferences?.keyboardShortcuts ?? {}
  const stashBinding = getEffectiveKeyBinding("draftStash", keyboardShortcuts)
  const stashBindingLabel = stashBinding ? formatKeyBinding(stashBinding) : null
  // Active input drives the virtual-keyboard guard and the "Tap"/"Press" +
  // keyboard-shortcut copy — a hardware keyboard is present only with a mouse.
  const isTouch = useInputMode() === "touch"
  const actionSide = useComposerActionSide()
  const count = drafts.length
  const now = useMemo(() => new Date(), [open])

  const handleStashCurrent = useCallback(() => {
    onStashCurrent()
    setOpen(false)
    closeFabDrawer?.()
  }, [onStashCurrent, closeFabDrawer])

  const handleRestore = useCallback(
    async (id: string) => {
      // Awaited, not fired and forgotten: the close + focus below are the only
      // feedback a restore has, so they must not run for one that refused.
      const result = await onRestore(id)
      if (result && !result.ok) {
        toast.error(RESTORE_REFUSAL_MESSAGE[result.reason])
        return
      }
      setOpen(false)
      closeFabDrawer?.()
      // Focus follows the restored content: skip Radix's trigger refocus and
      // land in the editor once the popover has torn down. The caret ends up
      // after the restored body via applyExternalEditorContent's end-focus
      // when the async rehydrate delivers it.
      suppressCloseFocusRef.current = true
      const focusComposer = bridge?.focusComposer
      if (focusComposer) setTimeout(() => focusComposer(), 0)
    },
    [onRestore, closeFabDrawer, bridge]
  )

  // Two-step delete: the trash icon opens a confirm dialog (parity with the
  // Drafts explorer — a draft is a draft, so both surfaces guard a delete the
  // same way). Close the popover first so the modal isn't trapped behind it. No
  // success toast by design: the confirm already makes the delete deliberate.
  const requestDelete = useCallback(
    (id: string) => {
      setOpen(false)
      closeFabDrawer?.()
      setDraftToDelete(id)
    },
    [closeFabDrawer]
  )

  const confirmDelete = useCallback(() => {
    if (draftToDelete) onDelete(draftToDelete)
    setDraftToDelete(null)
  }, [draftToDelete, onDelete])

  // Arrow keys walk the draft rows so a keyboard-opened list (Cmd/Ctrl+S on an
  // empty composer) is pick-able without a mouse; Enter activates the focused
  // row natively.
  const handleContentKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-draft-row]"))
    if (rows.length === 0) return
    e.preventDefault()
    const idx = rows.indexOf(document.activeElement as HTMLButtonElement)
    const step = e.key === "ArrowDown" ? 1 : -1
    // Focus outside the rows (idx -1): Down enters at the top, Up at the bottom.
    const next = idx === -1 && step === -1 ? rows.length - 1 : (idx + step + rows.length) % rows.length
    rows[next]?.focus()
  }, [])

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

        <PopoverContent
          ref={contentRef}
          align={composerPopoverAlign(actionSide)}
          side="top"
          sideOffset={8}
          className="w-80 p-0"
          {...keepEditorFocusProps(isTouch)}
          onKeyDown={handleContentKeyDown}
          onCloseAutoFocus={(e) => {
            // Touch never refocuses the trigger (keepEditorFocusProps
            // behavior, re-stated since this prop overrides the spread); a
            // restore-close skips it too so focus can land in the editor.
            if (isTouch || suppressCloseFocusRef.current) e.preventDefault()
            suppressCloseFocusRef.current = false
          }}
          onOpenAutoFocus={(e) => {
            // Touch keeps the editor focused (keepEditorFocusProps behavior,
            // re-stated here because this prop overrides the spread). Desktop
            // lands focus on the first draft row so ArrowUp/Down + Enter work
            // immediately after a keyboard open; with no rows Radix's default
            // content focus stands.
            if (isTouch) {
              e.preventDefault()
              return
            }
            const first = contentRef.current?.querySelector<HTMLButtonElement>("[data-draft-row]")
            if (first) {
              e.preventDefault()
              first.focus()
            }
          }}
        >
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
              {!isTouch && stashBindingLabel && <span className="text-muted-foreground ml-1">{stashBindingLabel}</span>}
            </Button>
          </div>

          {drafts.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {isTouch || !stashBindingLabel ? (
                <>
                  No saved drafts yet. {isTouch ? "Tap" : "Use"} "Save current" to stash what you're typing and start
                  fresh.
                </>
              ) : (
                <>
                  No saved drafts yet. Press <span className="font-medium text-foreground">{stashBindingLabel}</span> to
                  stash what you're typing and start fresh.
                </>
              )}
            </div>
          ) : (
            <ul className="max-h-64 overflow-y-auto py-1" role="list">
              {drafts.map((draft, index) => {
                const preview = rowPreview(draft, previewById)
                const attachmentCount = draft.attachments?.length ?? 0
                const origin = originById?.get(draft.id)
                const isBorrowed = origin?.tier === "borrowed"
                // The seam, not a per-row badge: the pile arrives own-first, so
                // the first borrowed row that follows an own row carries it. All
                // own or all borrowed → no header at all.
                const startsBorrowedGroup =
                  isBorrowed && index > 0 && originById?.get(drafts[index - 1]!.id)?.tier !== "borrowed"
                return (
                  <Fragment key={draft.id}>
                    {startsBorrowedGroup && (
                      <li
                        role="presentation"
                        data-testid="stashed-drafts-borrowed-separator"
                        className="flex items-center gap-2 px-3 pt-2 pb-1"
                      >
                        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          From elsewhere
                        </span>
                        <span className="h-px flex-1 bg-border" aria-hidden />
                      </li>
                    )}
                    <li className="group/row reveal-host">
                      <div className="flex items-start gap-2 px-3 py-2 hover:bg-muted/60 focus-within:bg-muted/60">
                        <button
                          type="button"
                          data-draft-row
                          onClick={() => void handleRestore(draft.id)}
                          className="flex-1 min-w-0 text-left focus:outline-none"
                        >
                          {/* Two lines are reserved whether or not the preview
                              fills them: a decrypting row resolves from one line
                              to two, and the popover sits over the composer
                              (INV-21). */}
                          <p className="text-sm leading-5 min-h-10 line-clamp-2 break-words">{preview}</p>
                          {/* One line, fixed height: the origin shares it with the
                              timestamp and truncates, so a name resolving late
                              never reflows the row. */}
                          <p className="mt-0.5 flex items-baseline gap-1.5 h-4 text-[11px] leading-4 text-muted-foreground">
                            {isBorrowed && (
                              <>
                                <span data-draft-origin className="min-w-0 truncate">
                                  {origin.label}
                                </span>
                                <span className="shrink-0" aria-hidden>
                                  ·
                                </span>
                              </>
                            )}
                            <span className="shrink-0">
                              {formatRelativeTime(new Date(draft.clientUpdatedAt), now, undefined, { terse: true })}
                              {attachmentCount > 0 && <span className="ml-1.5">· {attachmentCount} 📎</span>}
                            </span>
                          </p>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Delete saved draft"
                          className="h-7 w-7 shrink-0 reveal-actions"
                          onClick={(e) => {
                            e.stopPropagation()
                            requestDelete(draft.id)
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  </Fragment>
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
