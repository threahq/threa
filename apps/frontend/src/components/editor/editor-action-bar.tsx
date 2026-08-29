import type { ReactNode } from "react"
import type { Editor } from "@tiptap/react"
import {
  AtSign,
  Slash,
  Paperclip,
  Maximize2,
  Minimize2,
  CalendarClock,
  MessageSquareDashed,
  SmilePlus,
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
 * Folds formatting behind the Aa button as a popover instead of an in-flow
 * toolbar: the marks row on top, then Emoji, Mention, the editor size toggle
 * and Schedule as rows. Emoji and Mention leave the foot when this is set.
 */
export interface EditorFormatPopover {
  editor: Editor | null
  linkPopoverOpen: boolean
  onLinkPopoverOpenChange: (open: boolean) => void
  onSchedule?: () => void
}

export interface EditorActionBarProps {
  editorHandle: RichEditorHandle | null
  formatPopover?: EditorFormatPopover
  /** Opens an aside beside this surface; the button sits after Attach. */
  onOpenAside?: () => void
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
  formatPopover,
  onOpenAside,
  trailingContent,
  side = "right",
}: EditorActionBarProps) {
  const folded = formatPopover !== undefined
  return (
    <div className={cn("flex items-center gap-1", side === "left" && "flex-row-reverse")}>
      {/* Spacer — pushes buttons to whichever edge `side` names */}
      <span className="flex-1" />

      {/* Expand/collapse toggle — mobile inline expansion */}
      {showExpand && onMobileExpandedChange && !folded && (
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
      {folded ? (
        <FormatPopover
          editorHandle={editorHandle}
          disabled={disabled}
          open={formatOpen}
          onOpenChange={onFormatOpenChange}
          mobileExpanded={mobileExpanded}
          onMobileExpandedChange={showExpand ? onMobileExpandedChange : undefined}
          {...formatPopover}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Formatting"
              aria-pressed={formatOpen}
              className={cn("h-7 w-7 shrink-0", formatOpen && "bg-accent text-accent-foreground")}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onFormatOpenChange(!formatOpen)}
              disabled={disabled}
            >
              <span className="text-[13px] font-bold leading-none tracking-tight">Aa</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Formatting
          </TooltipContent>
        </Tooltip>
      )}

      {showEmoji && !folded && (
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

      {showMention && !folded && (
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

      {onOpenAside && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Open an aside"
              className="h-7 w-7 shrink-0"
              onPointerDown={(e) => e.preventDefault()}
              onClick={onOpenAside}
              disabled={disabled}
            >
              <MessageSquareDashed className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Open an aside
          </TooltipContent>
        </Tooltip>
      )}

      {trailingContent}
    </div>
  )
}

interface FormatPopoverProps extends EditorFormatPopover {
  editorHandle: RichEditorHandle | null
  disabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  mobileExpanded: boolean
  onMobileExpandedChange?: (expanded: boolean) => void
}

/**
 * The folded formatting surface. Nothing in it may take focus: the editor keeps
 * the caret and the soft keyboard the whole time (`keepEditorFocusProps` on the
 * content, pointerdown prevented on every row). Rows act on click, never on
 * pointerdown — acting early closes the popover under a finger still down and
 * the trailing click lands on whatever is beneath. Marks keep the popover open
 * (several usually go together); the rows close it, since each hands over to a
 * surface of its own (a suggestion popup, the resized editor, the schedule
 * picker).
 */
function FormatPopover({
  editorHandle,
  disabled,
  open,
  onOpenChange,
  mobileExpanded,
  onMobileExpandedChange,
  editor,
  linkPopoverOpen,
  onLinkPopoverOpenChange,
  onSchedule,
}: FormatPopoverProps) {
  const row = (label: string, icon: ReactNode, action: () => void) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      className="h-9 w-full justify-start gap-2 px-2 text-sm"
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        onOpenChange(false)
        action()
      }}
    >
      {icon}
      {label}
    </Button>
  )
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Formatting"
          className={cn("h-7 w-7 shrink-0", open && "bg-accent text-accent-foreground")}
          onPointerDown={(e) => e.preventDefault()}
          disabled={disabled}
        >
          <span className="text-[13px] font-bold leading-none tracking-tight">Aa</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        className="w-[min(22rem,calc(100vw-1rem))] p-1"
        data-testid="composer-format-popover"
        {...keepEditorFocusProps(true)}
      >
        <div data-testid="composer-format-toolbar">
          <EditorToolbar
            editor={editor}
            isVisible
            inline
            inlinePosition="below"
            linkPopoverOpen={linkPopoverOpen}
            onLinkPopoverOpenChange={onLinkPopoverOpenChange}
            showSpecialInputControls
          />
        </div>
        <div className="mt-1 flex flex-col border-t pt-1">
          {row("Emoji", <SmilePlus className="h-4 w-4" />, () => editorHandle?.insertEmoji())}
          {row("Mention", <AtSign className="h-4 w-4" />, () => editorHandle?.insertMention())}
          {onMobileExpandedChange &&
            row(
              mobileExpanded ? "Minimize editor" : "Expand editor",
              mobileExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />,
              () => onMobileExpandedChange(!mobileExpanded)
            )}
          {onSchedule && row("Schedule", <CalendarClock className="h-4 w-4" />, onSchedule)}
        </div>
      </PopoverContent>
    </Popover>
  )
}
