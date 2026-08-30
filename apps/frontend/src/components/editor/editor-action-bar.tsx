import { useState, type ReactNode } from "react"
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
 * The phone foot: Aa · + · trailing. Aa swaps the row for the marks
 * (`EditorToolbar` in its foot position, with `trailingContent` after it);
 * everything else lives behind the + menu.
 */
export interface EditorFormatFoot {
  editor: Editor | null
  linkPopoverOpen: boolean
  onLinkPopoverOpenChange: (open: boolean) => void
  /** What follows the marks while formatting (Send); the rest of the foot's trailing content is off-screen then. */
  trailingContent: ReactNode
}

export interface EditorFootMenu {
  onAttach?: () => void
  onOpenAside?: () => void
  onSchedule?: () => void
  onOpenDrafts?: () => void
}

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
  if (folded && formatOpen) {
    return (
      <div className="flex items-center gap-1">
        <FormatToggle open onOpenChange={onFormatOpenChange} disabled={disabled} />
        <div className="min-w-0 flex-1">
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
        {formatFoot.trailingContent}
      </div>
    )
  }
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
      <FormatToggle open={formatOpen} onOpenChange={onFormatOpenChange} disabled={disabled} />

      {folded && (
        <FootMenu
          disabled={disabled}
          mobileExpanded={mobileExpanded}
          onMobileExpandedChange={showExpand ? onMobileExpandedChange : undefined}
          {...footMenu}
        />
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

      {showAttach && onAttachClick && !folded && (
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled: boolean
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
          className={cn("h-7 w-7 shrink-0", open && "bg-accent text-accent-foreground")}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onOpenChange(!open)}
          disabled={disabled}
        >
          <span className="text-[13px] font-bold leading-none tracking-tight">Aa</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        Formatting
      </TooltipContent>
    </Tooltip>
  )
}

interface FootMenuProps extends EditorFootMenu {
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
  disabled,
  mobileExpanded,
  onMobileExpandedChange,
  onAttach,
  onOpenAside,
  onSchedule,
  onOpenDrafts,
}: FootMenuProps) {
  const [open, setOpen] = useState(false)
  const row = (label: string, icon: ReactNode, action: () => void) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      className="h-9 w-full justify-start gap-2 px-2 text-sm"
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        setOpen(false)
        action()
      }}
    >
      {icon}
      {label}
    </Button>
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="More"
          className={cn("h-7 w-7 shrink-0", open && "bg-accent text-accent-foreground")}
          onPointerDown={(e) => e.preventDefault()}
          disabled={disabled}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className="flex w-48 flex-col p-1"
        data-testid="composer-foot-menu"
        data-composer-chrome
        {...keepEditorFocusProps(true)}
      >
        {onAttach && row("Attach files", <Paperclip className="h-4 w-4" />, onAttach)}
        {onOpenAside && row("Open an aside", <MessageSquareDashed className="h-4 w-4" />, onOpenAside)}
        {onSchedule && row("Schedule", <CalendarClock className="h-4 w-4" />, onSchedule)}
        {onOpenDrafts && row("Drafts", <FileEdit className="h-4 w-4" />, onOpenDrafts)}
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
