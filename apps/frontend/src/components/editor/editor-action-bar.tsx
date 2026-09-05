import { useEffect, useState, type ReactNode } from "react"
import type { Editor } from "@tiptap/react"
import {
  AtSign,
  Slash,
  Paperclip,
  Maximize2,
  Minimize2,
  CalendarClock,
  FileEdit,
  MessageSquareDashed,
  Plus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { keepEditorFocusProps } from "@/lib/keep-editor-focus"
import { cn } from "@/lib/utils"
import type { ComposerActionSide } from "@threa/types"
import { EditorToolbar } from "./editor-toolbar"
import type { RichEditorHandle } from "./rich-editor"

function handlePointerAction(action: () => void) {
  return (event: React.PointerEvent) => {
    event.preventDefault()
    action()
  }
}

function handleKeyboardClick(action: () => void) {
  return (event: React.MouseEvent) => {
    if (event.detail === 0) action()
  }
}

/**
 * The phone foot: + · `trailingContent` on the left, Aa · Send on the right.
 * Aa stays put and slides the marks (`EditorToolbar` in its foot position) out
 * to its left, hiding + and `trailingContent` (kept mounted, off-screen: the
 * pickers in it keep their popovers and open bridges). Everything else lives
 * behind the + menu.
 */
export interface EditorFormatFoot {
  /** The owning composer's id, stamped on portaled chrome (`data-composer-chrome`)
   *  so its blur handling can tell this composer's menu from another's. */
  chromeId: string
  editor: Editor | null
  linkPopoverOpen: boolean
  onLinkPopoverOpenChange: (open: boolean) => void
  sendButton: ReactNode
}

export interface EditorFootMenu {
  onAttach?: () => void
  onOpenAside?: () => void
  onSchedule?: () => void
  /** Pending sends for this stream. The picker's trigger is off-screen in the
   *  foot, so its presence dot rides the "+" and its count rides the row. */
  scheduledCount?: number
  onOpenDrafts?: () => void
  /** Saved drafts in this composer's pile; same reason as `scheduledCount`. */
  draftCount?: number
}

const MARKS_SLIDE_MS = 200

export interface EditorActionBarProps {
  editorHandle: RichEditorHandle | null
  formatFoot?: EditorFormatFoot
  /** With `formatFoot`: the + menu's rows. */
  footMenu?: EditorFootMenu
  disabled?: boolean
  // Toggle state
  formatOpen: boolean
  onFormatOpenChange: (open: boolean) => void
  mobileExpanded?: boolean
  onMobileExpandedChange?: (expanded: boolean) => void
  // Optional buttons
  showExpand?: boolean
  showAttach?: boolean
  showMention?: boolean
  showEmoji?: boolean
  showSlashCommand?: boolean
  onAttachClick?: () => void
  // Desktop expand (opens fullscreen modal)
  showDesktopExpand?: boolean
  onDesktopExpandClick?: () => void
  // Trailing slot: Send button (composer) or Cancel+Save (edit form)
  trailingContent: ReactNode
  /**
   * Which edge the row's controls hug. "left" mirrors the row so `trailingContent`
   * (which carries Send) lands under a left thumb rather than in the opposite
   * corner from it.
   */
  side?: ComposerActionSide
}

export function EditorActionBar({
  editorHandle,
  disabled = false,
  formatOpen,
  onFormatOpenChange,
  mobileExpanded = false,
  onMobileExpandedChange,
  showExpand = true,
  showAttach = true,
  showMention = true,
  showEmoji = true,
  showSlashCommand = false,
  onAttachClick,
  showDesktopExpand = false,
  onDesktopExpandClick,
  formatFoot,
  footMenu,
  trailingContent,
  side = "right",
}: EditorActionBarProps) {
  const folded = formatFoot !== undefined
  // The marks row slides out the way it slid in, so it stays mounted for one
  // animation after `formatOpen` drops; the rest of the foot returns after.
  const [lastFormatOpen, setLastFormatOpen] = useState(formatOpen)
  const [closingMarks, setClosingMarks] = useState(false)
  if (lastFormatOpen !== formatOpen) {
    setLastFormatOpen(formatOpen)
    setClosingMarks(folded && !formatOpen)
  }
  useEffect(() => {
    if (!closingMarks) return
    const timer = setTimeout(() => setClosingMarks(false), MARKS_SLIDE_MS)
    return () => clearTimeout(timer)
  }, [closingMarks])
  if (folded) {
    const marksShown = formatOpen || closingMarks
    return (
      <div className={cn("flex items-center gap-1", side === "left" && "flex-row-reverse")}>
        {/* Every control hugs Send's edge so a thumb reaches all of them; the
            marks take the empty side when they slide out. */}
        <div className="min-w-0 flex-1">
          {marksShown && (
            <div
              className={cn(
                "duration-200 fill-mode-forwards",
                formatOpen
                  ? "animate-in fade-in-0 slide-in-from-right-8"
                  : "pointer-events-none animate-out fade-out-0 slide-out-to-right-8"
              )}
            >
              <EditorToolbar
                editor={formatFoot.editor}
                isVisible
                inline
                inlinePosition="foot"
                linkPopoverOpen={formatFoot.linkPopoverOpen}
                onLinkPopoverOpenChange={formatFoot.onLinkPopoverOpenChange}
                showSpecialInputControls
              />
            </div>
          )}
        </div>
        {!marksShown && (
          <FootMenu
            chromeId={formatFoot.chromeId}
            disabled={disabled}
            mobileExpanded={mobileExpanded}
            onMobileExpandedChange={showExpand ? onMobileExpandedChange : undefined}
            {...footMenu}
          />
        )}
        {/* One wrapper either way: swapping elements would remount the mic
            mid-take and the hidden pickers with their open bridges. */}
        <div hidden={marksShown} className={marksShown ? undefined : "contents"}>
          {trailingContent}
        </div>
        <FormatToggle open={formatOpen} onOpenChange={onFormatOpenChange} disabled={disabled} large />
        {formatFoot.sendButton}
      </div>
    )
  }
  return (
    <div className={cn("flex items-center gap-1", side === "left" && "flex-row-reverse")}>
      {/* Spacer — pushes buttons to whichever edge `side` names */}
      <span className="flex-1" />

      {/* Expand/collapse toggle — mobile inline expansion */}
      {showExpand && onMobileExpandedChange && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={mobileExpanded ? "Minimize editor" : "Expand editor"}
              aria-pressed={mobileExpanded}
              className="h-7 w-7 shrink-0"
              onPointerDown={handlePointerAction(() => onMobileExpandedChange(!mobileExpanded))}
              onClick={handleKeyboardClick(() => onMobileExpandedChange(!mobileExpanded))}
              disabled={disabled}
            >
              {mobileExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {mobileExpanded ? "Minimize" : "Expand"}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Desktop expand — opens fullscreen editor modal */}
      {showDesktopExpand && onDesktopExpandClick && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Expand to fullscreen editor"
              className="h-7 w-7 shrink-0"
              onPointerDown={handlePointerAction(onDesktopExpandClick)}
              onClick={handleKeyboardClick(onDesktopExpandClick)}
              disabled={disabled}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Expand editor
          </TooltipContent>
        </Tooltip>
      )}

      {/* Format toggle — split: pointerdown only prevents blur, click toggles toolbar.
         Firing the toggle on pointerdown would cause the newly-appeared toolbar buttons
         to receive the subsequent pointerup/click, inadvertently activating a mark. */}
      <FormatToggle open={formatOpen} onOpenChange={onFormatOpenChange} disabled={disabled} />

      {showEmoji && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Insert emoji"
              className="h-7 w-7 shrink-0"
              onPointerDown={handlePointerAction(() => editorHandle?.insertEmoji())}
              onClick={handleKeyboardClick(() => editorHandle?.insertEmoji())}
              disabled={disabled}
            >
              <span className="text-sm leading-none">😊</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Emoji
          </TooltipContent>
        </Tooltip>
      )}

      {showMention && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Insert mention"
              className="h-7 w-7 shrink-0"
              onPointerDown={handlePointerAction(() => editorHandle?.insertMention())}
              onClick={handleKeyboardClick(() => editorHandle?.insertMention())}
              disabled={disabled}
            >
              <AtSign className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Mention
          </TooltipContent>
        </Tooltip>
      )}

      {showSlashCommand && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Insert command"
              className="h-7 w-7 shrink-0"
              onPointerDown={handlePointerAction(() => editorHandle?.insertSlash())}
              onClick={handleKeyboardClick(() => editorHandle?.insertSlash())}
              disabled={disabled}
            >
              <Slash className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Command
          </TooltipContent>
        </Tooltip>
      )}

      {showAttach && onAttachClick && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Attach files"
              className="h-7 w-7 shrink-0"
              onClick={onAttachClick}
              disabled={disabled}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Attach files
          </TooltipContent>
        </Tooltip>
      )}

      {trailingContent}
    </div>
  )
}

function FormatToggle({
  open,
  onOpenChange,
  disabled,
  large = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled: boolean
  /** The phone foot's Aa: Send-sized, beside Send. */
  large?: boolean
}) {
  // Split: pointerdown only prevents blur, click toggles. Toggling on
  // pointerdown would hand the trailing pointerup/click to whatever control
  // appears under the finger.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Formatting"
          aria-pressed={open}
          className={cn("shrink-0", large ? "h-[30px] w-9" : "h-7 w-7", open && "bg-accent text-accent-foreground")}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onOpenChange(!open)}
          disabled={disabled}
        >
          <span className={cn("font-bold leading-none tracking-tight", large ? "text-[15px]" : "text-[13px]")}>Aa</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        Formatting
      </TooltipContent>
    </Tooltip>
  )
}

interface FootMenuProps extends EditorFootMenu {
  chromeId: string
  disabled: boolean
  mobileExpanded: boolean
  onMobileExpandedChange?: (expanded: boolean) => void
}

/**
 * The + menu. Nothing in it may take focus: the editor keeps the caret and the
 * soft keyboard the whole time (`keepEditorFocusProps` on the content,
 * pointerdown prevented on every row). Rows act on click, never on pointerdown
 * (acting early closes the menu under a finger still down and the trailing
 * click lands on whatever is beneath), and each closes the menu, since it
 * hands over to a surface of its own.
 */
function FootMenu({
  chromeId,
  disabled,
  mobileExpanded,
  onMobileExpandedChange,
  onAttach,
  onOpenAside,
  onSchedule,
  scheduledCount = 0,
  onOpenDrafts,
  draftCount = 0,
}: FootMenuProps) {
  const [open, setOpen] = useState(false)
  const row = (label: string, icon: ReactNode, action: () => void, badge?: { count: number; label: string }) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      // The count replaces the content-derived accessible name, so the label
      // has to ride inside it.
      aria-label={badge ? `${label} (${badge.label})` : undefined}
      className="h-9 w-full justify-start gap-2 px-2 text-sm"
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        setOpen(false)
        action()
      }}
    >
      {icon}
      {label}
      {badge && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{badge.count}</span>}
    </Button>
  )
  // What the menu holds, named for the trigger. Only rows the menu actually
  // offers count: a foot without a Drafts row must not grow a dot for drafts
  // it can't reach.
  const waiting = [
    onOpenDrafts && draftCount > 0 ? `${draftCount} saved draft${draftCount === 1 ? "" : "s"}` : null,
    onSchedule && scheduledCount > 0 ? `${scheduledCount} scheduled` : null,
  ].filter((part): part is string => part !== null)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={waiting.length > 0 ? `More (${waiting.join(", ")})` : "More"}
          className={cn("relative h-7 w-7 shrink-0", open && "bg-accent text-accent-foreground")}
          onPointerDown={(e) => e.preventDefault()}
          disabled={disabled}
        >
          <Plus className="h-4 w-4" />
          {waiting.length > 0 && (
            // Same presence dot the drafts/scheduled triggers wear on desktop —
            // the counts themselves are on the rows behind it.
            <span
              className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-muted-foreground/60 pointer-events-none"
              aria-hidden
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className="flex w-48 flex-col p-1"
        data-testid="composer-foot-menu"
        data-composer-chrome={chromeId}
        {...keepEditorFocusProps(true)}
      >
        {onAttach && row("Attach files", <Paperclip className="h-4 w-4" />, onAttach)}
        {onOpenAside && row("Open an aside", <MessageSquareDashed className="h-4 w-4" />, onOpenAside)}
        {onSchedule &&
          row(
            "Schedule",
            <CalendarClock className="h-4 w-4" />,
            onSchedule,
            scheduledCount > 0 ? { count: scheduledCount, label: `${scheduledCount} pending` } : undefined
          )}
        {onOpenDrafts &&
          row(
            "Drafts",
            <FileEdit className="h-4 w-4" />,
            onOpenDrafts,
            draftCount > 0 ? { count: draftCount, label: `${draftCount} saved` } : undefined
          )}
        {onMobileExpandedChange &&
          row(
            mobileExpanded ? "Minimize editor" : "Expand editor",
            mobileExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />,
            () => onMobileExpandedChange(!mobileExpanded)
          )}
      </PopoverContent>
    </Popover>
  )
}
