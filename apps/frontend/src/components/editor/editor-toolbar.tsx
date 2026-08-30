import { useLayoutEffect, useEffect, useState, useCallback, useReducer, useRef, useMemo } from "react"
import type { ChainedCommands, Editor } from "@tiptap/react"
import { useFloating, offset, flip, shift, autoUpdate } from "@floating-ui/react"
import {
  Bold,
  Italic,
  Strikethrough,
  Link2,
  Quote,
  Code,
  Braces,
  List,
  ListOrdered,
  ChevronDown,
  ListIndentIncrease,
  ListIndentDecrease,
  Table as TableIcon,
  Rows3,
  Columns3,
  Trash2,
} from "lucide-react"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { LinkEditor } from "./link-editor"
import { heldRange } from "./held-selection-extension"
import { indentSelection, dedentSelection, handleLinkToolbarAction, isSuggestionActive } from "./editor-behaviors"
import { toggleMultilineBlock } from "./multiline-blocks"
import { cn } from "@/lib/utils"
import { usePreferences } from "@/contexts"
import { getEffectiveEditorBindings, formatKeyBinding } from "@/lib/keyboard-shortcuts"
import { keepEditorFocusProps } from "@/lib/keep-editor-focus"

interface EditorToolbarProps {
  editor: Editor | null
  isVisible: boolean
  linkPopoverOpen?: boolean
  onLinkPopoverOpenChange?: (open: boolean) => void
  /** Called when an internal dropdown (e.g. StylePicker) opens or closes */
  onDropdownOpenChange?: (open: boolean) => void
  /** Render as an inline block (no floating positioning). Used when the toolbar
   *  is pinned inside the input box via the format button. */
  inline?: boolean
  /** Where the inline toolbar sits relative to the editor content.
   *  "above" = border-bottom divider (default), "below" = border-top divider,
   *  "foot" = the composer's own foot row, no divider or margin of its own. */
  inlinePosition?: "above" | "below" | "foot"
  /** Extra content rendered after the formatting buttons (e.g. action buttons, close X).
   *  Only applies when `inline` is true. */
  trailingContent?: React.ReactNode
  /** Show mobile-only editing controls like indent/dedent in a separate section. */
  showSpecialInputControls?: boolean
}

function linkHrefInRange(editor: Editor, range: { from: number; to: number }): string | null {
  const linkType = editor.schema.marks.link
  let href: string | null = null
  editor.state.doc.nodesBetween(range.from, range.to, (node) => {
    if (href !== null) return false
    const mark = linkType.isInSet(node.marks)
    if (mark) href = mark.attrs.href
  })
  return href
}

interface LinkEditorSnapshot {
  initialUrl: string
  isActive: boolean
  held: boolean
  selectionRange: {
    from: number
    to: number
  }
}

export function EditorToolbar({
  editor,
  isVisible,
  linkPopoverOpen,
  onLinkPopoverOpenChange,
  onDropdownOpenChange,
  inline = false,
  inlinePosition = "above",
  trailingContent,
  showSpecialInputControls = false,
}: EditorToolbarProps) {
  const { refs, floatingStyles, update } = useFloating({
    placement: "top",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })
  const floatingRootRef = useRef<HTMLDivElement | null>(null)
  const lastSelectionRectRef = useRef<DOMRect>(new DOMRect())
  const [linkEditorSnapshot, setLinkEditorSnapshot] = useState<LinkEditorSnapshot | null>(null)

  const { preferences } = usePreferences()
  const kb = preferences?.keyboardShortcuts ?? {}
  const effectiveEditorBindings = useMemo(() => getEffectiveEditorBindings(kb), [kb])
  const shortcutHint = useCallback(
    (actionId: string): string | undefined => {
      const binding = effectiveEditorBindings[actionId]
      return binding ? formatKeyBinding(binding) : undefined
    },
    [effectiveEditorBindings]
  )

  // Virtual reference: position the toolbar above the current text selection
  useLayoutEffect(() => {
    refs.setReference({
      getBoundingClientRect() {
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const rect = sel.getRangeAt(0).getBoundingClientRect()
          lastSelectionRectRef.current = rect
          return rect
        }
        if (linkPopoverOpen) {
          return lastSelectionRectRef.current
        }
        return new DOMRect()
      },
    })
  }, [refs, linkPopoverOpen])

  // Re-position whenever the selection moves.
  // EditorToolbar is always mounted in the tree — `return null` below is a
  // rendering guard only, not an unmount. Gating on isVisible and !inline avoids
  // unnecessary update() calls while the toolbar is hidden or in inline mode.
  useEffect(() => {
    if (!editor || !isVisible || inline) return
    editor.on("selectionUpdate", update)
    return () => {
      editor.off("selectionUpdate", update)
    }
  }, [editor, update, isVisible, inline])

  // Re-render when the editor state changes so isActive() reflects current marks/nodes.
  // Without this, the toolbar only updates when the parent re-renders (e.g. on typing),
  // causing toggle buttons to appear stale until the next keystroke.
  const [, forceRender] = useReducer((c: number) => c + 1, 0)
  useEffect(() => {
    if (!editor || !isVisible) return
    editor.on("transaction", forceRender)
    return () => {
      editor.off("transaction", forceRender)
    }
  }, [editor, isVisible])

  useEffect(() => {
    if (inline || !linkPopoverOpen || !onLinkPopoverOpenChange) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }

      if (floatingRootRef.current?.contains(target)) {
        return
      }

      onLinkPopoverOpenChange(false)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [inline, linkPopoverOpen, onLinkPopoverOpenChange])

  useEffect(() => {
    if (!linkPopoverOpen) {
      setLinkEditorSnapshot(null)
    }
  }, [linkPopoverOpen])

  if (!editor || !isVisible) return null

  const isLinkActive = editor.isActive("link")
  const isMobileInlineToolbar = inline && inlinePosition !== "above"
  const separatorClassName = cn("mx-1 h-6 shrink-0", isMobileInlineToolbar && "mx-1.5")
  // While a range is held (see HeldSelectionExtension) the selection is a
  // collapsed caret, so every command selects the held range first and
  // collapses again after; both are no-ops when nothing is held.
  const held = heldRange(editor.state)
  const run = (build: (chain: ChainedCommands) => ChainedCommands) =>
    build(editor.chain().focus().selectHeld()).collapseToHeld().run()
  const runOnHeld = (action: () => void) => {
    editor.commands.selectHeld()
    action()
    editor.commands.collapseToHeld()
  }
  const markActive = (name: string) =>
    held ? editor.state.doc.rangeHasMark(held.from, held.to, editor.schema.marks[name]) : editor.isActive(name)
  const handleLinkButtonAction = () => {
    const { from, to } = held ?? editor.state.selection
    // The held caret sits at the range's end, past a (non-inclusive) link, so
    // the URL comes from the range itself.
    const initialUrl = (held ? linkHrefInRange(editor, held) : editor.getAttributes("link").href) || ""
    const nextSnapshot = {
      initialUrl,
      isActive: markActive("link") || !!initialUrl,
      held: held !== null,
      selectionRange: { from, to },
    }
    // A held range is a selection, never a caret to step out of a link with.
    const opensOnHeld = held !== null && !linkPopoverOpen
    if (opensOnHeld) onLinkPopoverOpenChange?.(true)
    const action = opensOnHeld ? "opened" : handleLinkToolbarAction(editor, !!linkPopoverOpen, onLinkPopoverOpenChange)

    if (action === "opened") {
      setLinkEditorSnapshot(nextSnapshot)
    }

    if (action === "closed") {
      setLinkEditorSnapshot(null)
    }
  }

  const buttons = (
    <>
      <StylePicker
        editor={editor}
        onOpenChange={onDropdownOpenChange}
        keepEditorFocus={isMobileInlineToolbar}
        roomy={isMobileInlineToolbar}
        keyboardAccessible={inline}
      />
      <Separator orientation="vertical" className={separatorClassName} />
      <ToolbarButton
        onAction={() => run((chain) => chain.toggleBold())}
        icon={Bold}
        label="Bold"
        shortcut={shortcutHint("formatBold")}
        isActive={markActive("bold")}
        roomy={isMobileInlineToolbar}
        showTooltip={!isMobileInlineToolbar}
        keyboardAccessible={inline}
      />
      <ToolbarButton
        onAction={() => run((chain) => chain.toggleItalic())}
        icon={Italic}
        label="Italic"
        shortcut={shortcutHint("formatItalic")}
        isActive={markActive("italic")}
        roomy={isMobileInlineToolbar}
        showTooltip={!isMobileInlineToolbar}
        keyboardAccessible={inline}
      />
      <ToolbarButton
        onAction={() => run((chain) => chain.toggleStrike())}
        icon={Strikethrough}
        label="Strikethrough"
        shortcut={shortcutHint("formatStrike")}
        isActive={markActive("strike")}
        roomy={isMobileInlineToolbar}
        showTooltip={!isMobileInlineToolbar}
        keyboardAccessible={inline}
      />
      <ToolbarButton
        onAction={() => run((chain) => chain.toggleCode())}
        icon={Code}
        label="Inline code"
        shortcut={shortcutHint("formatCode")}
        isActive={markActive("code")}
        roomy={isMobileInlineToolbar}
        showTooltip={!isMobileInlineToolbar}
        keyboardAccessible={inline}
      />
      <ToolbarButton
        onAction={handleLinkButtonAction}
        icon={Link2}
        label="Link"
        isActive={markActive("link") || !!linkPopoverOpen}
        deferActionUntilClick
        roomy={isMobileInlineToolbar}
        showTooltip={!isMobileInlineToolbar}
        keyboardAccessible={inline}
      />
      <Separator orientation="vertical" className={separatorClassName} />
      <ToolbarButton
        onAction={() => runOnHeld(() => toggleMultilineBlock(editor, "blockquote"))}
        icon={Quote}
        label="Quote"
        isActive={editor.isActive("blockquote")}
        roomy={isMobileInlineToolbar}
        showTooltip={!isMobileInlineToolbar}
        keyboardAccessible={inline}
      />
      <ToolbarButton
        onAction={() => run((chain) => chain.toggleBulletList())}
        icon={List}
        label="Bullet list"
        isActive={editor.isActive("bulletList")}
        roomy={isMobileInlineToolbar}
        showTooltip={!isMobileInlineToolbar}
        keyboardAccessible={inline}
      />
      <ToolbarButton
        onAction={() => run((chain) => chain.toggleOrderedList())}
        icon={ListOrdered}
        label="Numbered list"
        isActive={editor.isActive("orderedList")}
        roomy={isMobileInlineToolbar}
        showTooltip={!isMobileInlineToolbar}
        keyboardAccessible={inline}
      />
      <ToolbarButton
        onAction={() => runOnHeld(() => toggleMultilineBlock(editor, "codeBlock"))}
        icon={Braces}
        label="Code block"
        shortcut={shortcutHint("formatCodeBlock")}
        isActive={editor.isActive("codeBlock")}
        roomy={isMobileInlineToolbar}
        showTooltip={!isMobileInlineToolbar}
        keyboardAccessible={inline}
      />
      <TableControls editor={editor} roomy={isMobileInlineToolbar} keyboardAccessible={inline} />
      {showSpecialInputControls && (
        <>
          <Separator orientation="vertical" className={separatorClassName} />
          <ToolbarButton
            onAction={() => {
              if (!isSuggestionActive(editor)) runOnHeld(() => indentSelection(editor))
            }}
            icon={ListIndentIncrease}
            label="Indent"
            roomy
            showTooltip={false}
          />
          <ToolbarButton
            onAction={() => {
              if (!isSuggestionActive(editor)) runOnHeld(() => dedentSelection(editor))
            }}
            icon={ListIndentDecrease}
            label="Dedent"
            roomy
            showTooltip={false}
          />
        </>
      )}
    </>
  )

  if (inline) {
    return (
      <TooltipProvider delayDuration={300}>
        {linkPopoverOpen && (
          <LinkEditor
            editor={editor}
            isActive={linkEditorSnapshot?.isActive ?? isLinkActive}
            initialUrl={linkEditorSnapshot?.initialUrl}
            selectionRange={linkEditorSnapshot?.selectionRange}
            onClose={() => {
              onLinkPopoverOpenChange?.(false)
              // The link editor restores the range as a real selection on its
              // way out, which the plugin reads as the user's; hold it again.
              if (linkEditorSnapshot?.held) editor.commands.holdSelection()
            }}
            className="rounded-md border bg-popover p-2 shadow-md mb-1"
          />
        )}
        <div
          className={cn(
            "relative",
            inlinePosition === "above" && "border-b border-border/50 mb-1",
            inlinePosition === "below" && "border-t border-border/50 mt-1"
          )}
        >
          <div
            className={cn(
              "flex items-center gap-0.5",
              inlinePosition === "above" && "py-1",
              inlinePosition === "below" && "pt-1"
            )}
          >
            <div
              data-testid={isMobileInlineToolbar ? "mobile-inline-toolbar-scroll" : undefined}
              className={cn(
                "flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                "overscroll-x-contain touch-pan-x",
                isMobileInlineToolbar ? "grow pb-1 -mb-1 pr-3" : "shrink",
                // The foot row's controls are Send-sized (30px); the roomy 36px
                // buttons would grow the row on open and shift the timeline.
                inlinePosition === "foot" &&
                  "[&_button]:h-[30px] [&_button[aria-pressed]]:w-[30px] [&_button[aria-pressed]]:min-w-[30px]"
              )}
            >
              {buttons}
            </div>
            {trailingContent}
          </div>
          {!trailingContent && !isMobileInlineToolbar && (
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-card to-transparent" />
          )}
        </div>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={(node) => {
          floatingRootRef.current = node
          refs.setFloating(node)
        }}
        style={floatingStyles}
        className="z-50 flex flex-col gap-1 max-w-[calc(100vw-16px)]"
      >
        {linkPopoverOpen && (
          <LinkEditor
            editor={editor}
            isActive={linkEditorSnapshot?.isActive ?? isLinkActive}
            initialUrl={linkEditorSnapshot?.initialUrl}
            selectionRange={linkEditorSnapshot?.selectionRange}
            onClose={() => onLinkPopoverOpenChange?.(false)}
            className="rounded-md border bg-popover p-2 shadow-md animate-in fade-in-0 slide-in-from-bottom-2 duration-150"
          />
        )}
        <div className="relative">
          <div
            className={cn(
              "flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              "animate-in fade-in-0 zoom-in-95 duration-150"
            )}
          >
            {buttons}
          </div>
          <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 rounded-r-md bg-gradient-to-l from-popover to-transparent" />
        </div>
      </div>
    </TooltipProvider>
  )
}

function StylePicker({
  editor,
  onOpenChange,
  keepEditorFocus = false,
  roomy = false,
  keyboardAccessible = false,
}: {
  editor: Editor
  onOpenChange?: (open: boolean) => void
  keepEditorFocus?: boolean
  roomy?: boolean
  keyboardAccessible?: boolean
}) {
  let activeLabel = "Normal"
  if (editor.isActive("heading", { level: 1 })) activeLabel = "Heading 1"
  else if (editor.isActive("heading", { level: 2 })) activeLabel = "Heading 2"
  else if (editor.isActive("heading", { level: 3 })) activeLabel = "Heading 3"

  const [mobileStyleOpen, setMobileStyleOpen] = useState(false)
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setMobileStyleOpen(open)
      onOpenChange?.(open)
    },
    [onOpenChange]
  )

  if (keepEditorFocus) {
    const selectParagraph = () => {
      editor.chain().focus().selectHeld().setParagraph().collapseToHeld().run()
      handleOpenChange(false)
    }
    const selectHeading = (level: 1 | 2 | 3) => {
      editor.chain().focus().selectHeld().toggleHeading({ level }).collapseToHeld().run()
      handleOpenChange(false)
    }
    const handleOptionPointerDown = (action: () => void) => (e: React.PointerEvent) => {
      e.preventDefault()
      action()
    }
    const handleOptionClick = (action: () => void) => (e: React.MouseEvent) => {
      if (e.detail === 0) action()
    }

    return (
      <Popover open={mobileStyleOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "gap-1 font-medium shrink-0",
              roomy
                ? "h-9 px-3 text-sm active:bg-muted hover:bg-transparent hover:text-current"
                : "h-8 px-2 text-xs hover:bg-muted"
            )}
            tabIndex={keyboardAccessible ? undefined : -1}
            onPointerDown={(e) => e.preventDefault()}
          >
            {activeLabel}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-auto min-w-[120px] p-1"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("h-8 w-full justify-start px-2 text-sm", !editor.isActive("heading") && "font-medium")}
            tabIndex={keyboardAccessible ? undefined : -1}
            onPointerDown={handleOptionPointerDown(selectParagraph)}
            onClick={handleOptionClick(selectParagraph)}
          >
            Normal
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "h-8 w-full justify-start px-2 text-sm",
              editor.isActive("heading", { level: 1 }) && "font-medium"
            )}
            tabIndex={keyboardAccessible ? undefined : -1}
            onPointerDown={handleOptionPointerDown(() => selectHeading(1))}
            onClick={handleOptionClick(() => selectHeading(1))}
          >
            Heading 1
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "h-8 w-full justify-start px-2 text-sm",
              editor.isActive("heading", { level: 2 }) && "font-medium"
            )}
            tabIndex={keyboardAccessible ? undefined : -1}
            onPointerDown={handleOptionPointerDown(() => selectHeading(2))}
            onClick={handleOptionClick(() => selectHeading(2))}
          >
            Heading 2
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "h-8 w-full justify-start px-2 text-sm",
              editor.isActive("heading", { level: 3 }) && "font-medium"
            )}
            tabIndex={keyboardAccessible ? undefined : -1}
            onPointerDown={handleOptionPointerDown(() => selectHeading(3))}
            onClick={handleOptionClick(() => selectHeading(3))}
          >
            Heading 3
          </Button>
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-xs font-medium hover:bg-muted shrink-0"
          tabIndex={keyboardAccessible ? undefined : -1}
        >
          {activeLabel}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[120px]"
        // Prevent Radix from moving focus back to the trigger on close —
        // the onSelect handlers already refocus the editor.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuItem
          onSelect={() => editor.chain().focus().setParagraph().run()}
          className={cn("text-sm", !editor.isActive("heading") && "font-medium")}
        >
          Normal
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className={cn("text-sm", editor.isActive("heading", { level: 1 }) && "font-medium")}
        >
          Heading 1
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={cn("text-sm", editor.isActive("heading", { level: 2 }) && "font-medium")}
        >
          Heading 2
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          className={cn("text-sm", editor.isActive("heading", { level: 3 }) && "font-medium")}
        >
          Heading 3
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TableControls({
  editor,
  roomy,
  keyboardAccessible,
}: {
  editor: Editor
  roomy: boolean
  keyboardAccessible: boolean
}) {
  const [open, setOpen] = useState(false)
  const inTable = editor.isActive("table")

  // When the cursor leaves the table, close the popover so the trigger reverts
  // to the plain "Insert table" button. Without this the popover would stay
  // open with disabled-looking controls.
  useEffect(() => {
    if (!inTable && open) setOpen(false)
  }, [inTable, open])

  if (!inTable) {
    return (
      <ToolbarButton
        onAction={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        icon={TableIcon}
        label="Insert table"
        roomy={roomy}
        showTooltip={!roomy}
        keyboardAccessible={keyboardAccessible}
      />
    )
  }

  const close = () => setOpen(false)
  const run = (action: () => void) => () => {
    action()
    close()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Edit table"
          onPointerDown={(e) => {
            // Match ToolbarButton's pointerdown-on-desktop pattern so focus
            // doesn't leave the editor while the popover opens.
            if (!roomy) e.preventDefault()
          }}
          onMouseDown={(e) => {
            if (roomy) e.preventDefault()
          }}
          className={cn(
            "px-1.5 shrink-0 gap-0.5 bg-muted-foreground/20 text-foreground",
            roomy
              ? "h-9 active:bg-muted hover:bg-muted-foreground/20 hover:text-current"
              : "h-8 hover:bg-muted-foreground/20"
          )}
          tabIndex={keyboardAccessible ? undefined : -1}
        >
          <TableIcon className="h-4 w-4 stroke-[2.5px]" />
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      {/* Table commands operate on the editor's live selection, so focus must
         stay on the editor on every platform (not just mobile) — pass `true`.
         This also adds the mousedown guard that keeps tapping a menu item from
         blurring the editor (and flickering the mobile keyboard). */}
      <PopoverContent align="start" side="top" className="w-48 p-1" {...keepEditorFocusProps(true)}>
        <TableMenuItem
          icon={Rows3}
          label="Add row above"
          onAction={run(() => editor.chain().focus().addRowBefore().run())}
          keyboardAccessible={keyboardAccessible}
          roomy={roomy}
        />
        <TableMenuItem
          icon={Rows3}
          label="Add row below"
          onAction={run(() => editor.chain().focus().addRowAfter().run())}
          keyboardAccessible={keyboardAccessible}
          roomy={roomy}
        />
        <TableMenuItem
          icon={Columns3}
          label="Add column left"
          onAction={run(() => editor.chain().focus().addColumnBefore().run())}
          keyboardAccessible={keyboardAccessible}
          roomy={roomy}
        />
        <TableMenuItem
          icon={Columns3}
          label="Add column right"
          onAction={run(() => editor.chain().focus().addColumnAfter().run())}
          keyboardAccessible={keyboardAccessible}
          roomy={roomy}
        />
        <Separator className="my-1" />
        <TableMenuItem
          icon={Trash2}
          label="Delete row"
          onAction={run(() => editor.chain().focus().deleteRow().run())}
          keyboardAccessible={keyboardAccessible}
          roomy={roomy}
        />
        <TableMenuItem
          icon={Trash2}
          label="Delete column"
          onAction={run(() => editor.chain().focus().deleteColumn().run())}
          keyboardAccessible={keyboardAccessible}
          roomy={roomy}
        />
        <TableMenuItem
          icon={Trash2}
          label="Delete table"
          danger
          onAction={run(() => editor.chain().focus().deleteTable().run())}
          keyboardAccessible={keyboardAccessible}
          roomy={roomy}
        />
      </PopoverContent>
    </Popover>
  )
}

function TableMenuItem({
  icon: Icon,
  label,
  onAction,
  danger,
  keyboardAccessible,
  roomy,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onAction: () => void
  danger?: boolean
  keyboardAccessible?: boolean
  roomy?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      // Desktop: act on pointerdown so the editor selection survives the menu
      // click (Tiptap commands rely on the current selection).
      // Mobile (roomy): defer to click. Acting on pointerdown closes the
      // popover before touchend lands, which lets the trailing click pass
      // through to whichever toolbar button now sits under the finger.
      onPointerDown={
        roomy
          ? undefined
          : (e) => {
              e.preventDefault()
              onAction()
            }
      }
      onClick={(e) => {
        if (roomy || e.detail === 0) onAction()
      }}
      className={cn(
        "h-8 w-full justify-start gap-2 px-2 text-sm font-normal",
        danger && "text-destructive hover:text-destructive"
      )}
      tabIndex={keyboardAccessible ? undefined : -1}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </Button>
  )
}

interface ToolbarButtonProps {
  onAction: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  shortcut?: string
  isActive?: boolean
  roomy?: boolean
  showTooltip?: boolean
  keyboardAccessible?: boolean
  deferActionUntilClick?: boolean
}

function ToolbarButton({
  onAction,
  icon: Icon,
  label,
  shortcut,
  isActive,
  roomy = false,
  showTooltip = true,
  keyboardAccessible = false,
  deferActionUntilClick = false,
}: ToolbarButtonProps) {
  // Desktop (non-roomy): fire on pointerdown for snappy interaction unless the
  // action changes layout immediately (for example opening the link editor),
  // in which case defer to click so the full click sequence still targets the button.
  // Mobile (roomy): use mousedown to prevent focus theft without blocking
  // touch-initiated scroll, then fire the action on click.
  const handlePointerDown = roomy
    ? undefined
    : (e: React.PointerEvent) => {
        e.preventDefault()
        if (!deferActionUntilClick) {
          onAction()
        }
      }
  const handleMouseDown = roomy ? (e: React.MouseEvent) => e.preventDefault() : undefined
  let handleClick: ((e: React.MouseEvent) => void) | (() => void)
  if (roomy || deferActionUntilClick) {
    handleClick = () => onAction()
  } else {
    handleClick = (e: React.MouseEvent) => {
      if (e.detail === 0) onAction()
    }
  }

  const button = (
    <Button
      variant="ghost"
      size="sm"
      onPointerDown={handlePointerDown}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      className={cn(
        "p-0 shrink-0",
        roomy ? "h-9 w-9 min-w-9 active:bg-muted hover:bg-transparent hover:text-current" : "h-8 w-8 hover:bg-muted",
        isActive && "bg-muted-foreground/20 text-foreground",
        isActive && roomy && "hover:bg-muted-foreground/20"
      )}
      tabIndex={keyboardAccessible ? undefined : -1}
      aria-label={label}
      aria-pressed={isActive}
    >
      <Icon className={cn("h-4 w-4", isActive && "stroke-[2.5px]")} />
    </Button>
  )

  if (!showTooltip) {
    return button
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium">{label}</span>
          {shortcut && <span className="text-muted-foreground">{shortcut}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
