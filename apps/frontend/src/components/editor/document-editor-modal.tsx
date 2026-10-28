import { useRef, useState, useEffect, useCallback, useMemo } from "react"
import { useEditor, EditorContent, useEditorState } from "@tiptap/react"
import { useParams } from "react-router-dom"
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
  ListChecks,
  Heading1,
  Heading2,
  Heading3,
} from "lucide-react"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { ComposerPillDndProvider } from "./composer-pill-dnd"
import { createEditorExtensions } from "./editor-extensions"
import { EditorBehaviors, handleBeforeInput, handleLinkToolbarAction } from "./editor-behaviors"
import { EDITOR_CONTENT_CLASS } from "./editor-content-class"
import { serializeToMarkdown, parseMarkdown, isProseMirrorClipboardEvent } from "./editor-markdown"
import { serializeClipboardSlice } from "./clipboard-copy"
import { insertPlainText, isPlainTextPaste } from "./plain-text-paste"
import { useMentionSuggestion, useChannelSuggestion, useEmojiSuggestion } from "./triggers"
import { useMentionables, useMarkdownTriggerLookups, type MentionStreamContext } from "@/hooks/use-mentionables"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { LinkEditor } from "./link-editor"
import { insertPastedText, toggleMultilineBlock } from "./multiline-blocks"
import { cn } from "@/lib/utils"
import { usePreferences } from "@/contexts"
import { getEffectiveEditorBindings, formatKeyBinding } from "@/lib/keyboard-shortcuts"

interface DocumentEditorModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialContent?: string
  onSend: (content: string) => void
  /** Called when modal is dismissed (Cancel, Escape, click outside) - returns current content for sync */
  onDismiss?: (content: string) => void
  streamName: string
  streamContext?: MentionStreamContext
}

export function DocumentEditorModal({
  open,
  onOpenChange,
  initialContent = "",
  onSend,
  onDismiss,
  streamName,
  streamContext,
}: DocumentEditorModalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isInternalUpdate = useRef(false)
  const wasOpenRef = useRef(false)
  const [linkEditorOpen, setLinkEditorOpen] = useState(false)

  const { mentionables } = useMentionables()
  const { getMentionType, isKnownChannel } = useMarkdownTriggerLookups(mentionables)
  const { suggestionConfig: mentionConfig, renderMentionList } = useMentionSuggestion(streamContext)
  const { suggestionConfig: channelConfig, renderChannelList } = useChannelSuggestion()

  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { emojis, emojiWeights, toEmoji } = useWorkspaceEmoji(workspaceId ?? "")
  const { suggestionConfig: emojiConfig, renderEmojiGrid } = useEmojiSuggestion({ emojis, emojiWeights })

  const initContentRef = useRef(initialContent)
  const getMentionTypeRef = useRef(getMentionType)
  const toEmojiRef = useRef(toEmoji)
  initContentRef.current = initialContent
  getMentionTypeRef.current = getMentionType
  toEmojiRef.current = toEmoji
  const markdownParseOptions = useMemo(() => ({ emojiAsText: true, isKnownChannel }), [isKnownChannel])

  // Ref for handleSubmit without re-creating extensions
  const handleSubmitRef = useRef(() => {})
  const editorRef = useRef<ReturnType<typeof useEditor>>(null)

  // Effective editor formatting bindings (updated reactively via ref)
  const { preferences } = usePreferences()
  const docCustomBindings = preferences?.keyboardShortcuts ?? {}
  const effectiveDocBindings = useMemo(() => getEffectiveEditorBindings(docCustomBindings), [docCustomBindings])
  const keyBindingsRef = useRef<Record<string, string>>({})
  keyBindingsRef.current = effectiveDocBindings
  const docShortcutHint = useCallback(
    (actionId: string): string | undefined => {
      const binding = effectiveDocBindings[actionId]
      return binding ? formatKeyBinding(binding) : undefined
    },
    [effectiveDocBindings]
  )

  // Create extensions (no cmdEnter handling - explicit Send button only)
  const extensions = useMemo(
    () => [
      ...createEditorExtensions({
        placeholder: "Write your message...",
        mentionSuggestion: mentionConfig,
        channelSuggestion: channelConfig,
        emojiSuggestion: emojiConfig,
        toEmoji,
      }),
      EditorBehaviors.configure({
        sendModeRef: { current: "cmdEnter" }, // Use cmdEnter mode in modal
        onSubmitRef: handleSubmitRef,
        keyBindingsRef: keyBindingsRef,
      }),
    ],
    [mentionConfig, channelConfig, emojiConfig, toEmoji]
  )

  const editor = useEditor({
    extensions,
    content: parseMarkdown(initialContent, getMentionType, toEmoji, markdownParseOptions),
    editorProps: {
      attributes: {
        class: cn("min-h-[300px] max-h-[60vh] overflow-y-auto w-full px-4 py-3 outline-none", EDITOR_CONTENT_CLASS),
      },
      clipboardTextSerializer: serializeClipboardSlice,
      handlePaste: (view, event) => {
        // Paste-without-formatting renders the clipboard's markdown down to
        // its text, so it preempts the internal-paste shortcut below.
        const pasteAsPlainText = isPlainTextPaste(view)

        if (!pasteAsPlainText && isProseMirrorClipboardEvent(event)) {
          return false
        }

        const text = event.clipboardData?.getData("text/plain")
        if (!text || !editorRef.current) {
          return false
        }

        const insert = pasteAsPlainText ? insertPlainText : insertPastedText
        const handled = insert(
          editorRef.current,
          text,
          getMentionTypeRef.current,
          toEmojiRef.current,
          markdownParseOptions
        )
        if (handled) {
          event.preventDefault()
        }

        return handled
      },
      handleDOMEvents: {
        beforeinput: (_view, event) => {
          const editor = editorRef.current
          if (!editor) return false
          return handleBeforeInput(editor, event as InputEvent, {
            getMentionType: getMentionTypeRef.current,
            toEmoji: toEmojiRef.current,
            parseOptions: markdownParseOptions,
          })
        },
      },
      handleKeyDown: (_view, event) => {
        // Cmd/Ctrl+Enter: send
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
          event.preventDefault()
          handleSubmitRef.current()
          return true
        }
        return false
      },
    },
  })

  editorRef.current = editor

  const handleSubmit = useCallback(() => {
    if (!editorRef.current) return
    const markdown = serializeToMarkdown(editorRef.current.getJSON())
    if (markdown.trim()) {
      onSend(markdown)
      onOpenChange(false)
    }
  }, [onSend, onOpenChange])

  const handleDismiss = useCallback(() => {
    if (editorRef.current && onDismiss) {
      const markdown = serializeToMarkdown(editorRef.current.getJSON())
      onDismiss(markdown)
    }
    onOpenChange(false)
  }, [onDismiss, onOpenChange])

  handleSubmitRef.current = handleSubmit

  // Reset content only when dialog transitions from closed to open
  useEffect(() => {
    const isNewlyOpened = open && !wasOpenRef.current
    wasOpenRef.current = open

    if (isNewlyOpened && editor && !editor.isDestroyed) {
      isInternalUpdate.current = true
      editor.commands.setContent(
        parseMarkdown(initContentRef.current, getMentionTypeRef.current, toEmojiRef.current, markdownParseOptions)
      )
      isInternalUpdate.current = false
      editor.commands.focus("end")
    }
  }, [open, editor])

  // Reactively check if content is empty (TipTap v3 requires useEditorState for reactive reads)
  const isEmpty = useEditorState({
    editor,
    selector: (ctx) => !ctx.editor || ctx.editor.isEmpty,
  })

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        handleDismiss()
      } else {
        onOpenChange(true)
      }
    },
    [handleDismiss, onOpenChange]
  )

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="w-[90vw] max-w-[800px] h-[80vh] max-h-[700px] sm:flex flex-col gap-0 p-0"
        drawerClassName="flex flex-col gap-0 p-0"
        hideCloseButton
        onPointerDownOutside={(e) => {
          // Prevent closing when clicking on suggestion popover
          const target = e.target as HTMLElement
          if (target.closest('[role="listbox"]')) {
            e.preventDefault()
          }
        }}
      >
        <ResponsiveDialogHeader className="px-4 py-3 border-b">
          <ResponsiveDialogTitle className="text-base font-medium">
            Message in <span className="text-primary">{streamName}</span>
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <TooltipProvider delayDuration={300}>
          <div className="flex items-center gap-0.5 px-4 py-2 border-b bg-muted/30 overflow-x-auto">
            <ToolbarButton
              onAction={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
              icon={Heading1}
              label="Heading 1"
              isActive={editor?.isActive("heading", { level: 1 })}
            />
            <ToolbarButton
              onAction={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
              icon={Heading2}
              label="Heading 2"
              isActive={editor?.isActive("heading", { level: 2 })}
            />
            <ToolbarButton
              onAction={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
              icon={Heading3}
              label="Heading 3"
              isActive={editor?.isActive("heading", { level: 3 })}
            />

            <Separator orientation="vertical" className="mx-1 h-6" />

            <ToolbarButton
              onAction={() => editor?.chain().focus().toggleBold().run()}
              icon={Bold}
              label="Bold"
              shortcut={docShortcutHint("formatBold")}
              isActive={editor?.isActive("bold")}
            />
            <ToolbarButton
              onAction={() => editor?.chain().focus().toggleItalic().run()}
              icon={Italic}
              label="Italic"
              shortcut={docShortcutHint("formatItalic")}
              isActive={editor?.isActive("italic")}
            />
            <ToolbarButton
              onAction={() => editor?.chain().focus().toggleStrike().run()}
              icon={Strikethrough}
              label="Strikethrough"
              shortcut={docShortcutHint("formatStrike")}
              isActive={editor?.isActive("strike")}
            />
            <ToolbarButton
              onAction={() => editor?.chain().focus().toggleCode().run()}
              icon={Code}
              label="Inline code"
              shortcut={docShortcutHint("formatCode")}
              isActive={editor?.isActive("code")}
            />
            <ToolbarButton
              onAction={() => editor && handleLinkToolbarAction(editor, linkEditorOpen, setLinkEditorOpen)}
              icon={Link2}
              label="Link"
              isActive={editor?.isActive("link") || linkEditorOpen}
            />

            <Separator orientation="vertical" className="mx-1 h-6" />

            <ToolbarButton
              onAction={() => editor && toggleMultilineBlock(editor, "blockquote")}
              icon={Quote}
              label="Quote"
              isActive={editor?.isActive("blockquote")}
            />
            <ToolbarButton
              onAction={() => editor?.chain().focus().toggleBulletList().run()}
              icon={List}
              label="Bullet list"
              isActive={editor?.isActive("bulletList")}
            />
            <ToolbarButton
              onAction={() => editor?.chain().focus().toggleOrderedList().run()}
              icon={ListOrdered}
              label="Numbered list"
              isActive={editor?.isActive("orderedList")}
            />
            <ToolbarButton
              onAction={() => editor?.chain().focus().toggleTaskList().run()}
              icon={ListChecks}
              label="Checklist"
              isActive={editor?.isActive("taskList")}
            />
            <ToolbarButton
              onAction={() => editor && toggleMultilineBlock(editor, "codeBlock")}
              icon={Braces}
              label="Code block"
              shortcut={docShortcutHint("formatCodeBlock")}
              isActive={editor?.isActive("codeBlock")}
            />
          </div>

          {linkEditorOpen && editor && (
            <LinkEditor
              editor={editor}
              isActive={editor.isActive("link")}
              onClose={() => {
                setLinkEditorOpen(false)
                editor.commands.focus()
              }}
            />
          )}
        </TooltipProvider>

        <div
          ref={containerRef}
          className="flex-1 overflow-hidden cursor-text"
          onClick={() => editor?.commands.focus("end")}
        >
          <ComposerPillDndProvider editor={editor}>
            <EditorContent editor={editor} className="h-full" />
            {renderMentionList()}
            {renderChannelList()}
            {renderEmojiGrid()}
          </ComposerPillDndProvider>
        </div>

        <ResponsiveDialogFooter className="px-4 py-3 border-t flex-row items-center">
          <span className="hidden sm:inline text-xs text-muted-foreground">
            <kbd className="kbd-hint">{navigator.platform?.includes("Mac") ? "⌘" : "Ctrl+"}↵</kbd> to send
          </span>
          <div className="flex gap-2 sm:ml-auto w-full sm:w-auto justify-end">
            <Button variant="ghost" onClick={handleDismiss}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isEmpty} className="flex-1 sm:flex-initial">
              Send
            </Button>
          </div>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

interface ToolbarButtonProps {
  onAction: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  shortcut?: string
  isActive?: boolean
}

function ToolbarButton({ onAction, icon: Icon, label, shortcut, isActive }: ToolbarButtonProps) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    onAction()
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={handleMouseDown}
          className={cn("h-8 w-8 p-0 hover:bg-muted", isActive && "bg-muted-foreground/20 text-foreground")}
          tabIndex={-1}
          aria-label={label}
          aria-pressed={isActive}
        >
          <Icon className={cn("h-4 w-4", isActive && "stroke-[2.5px]")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium">{label}</span>
          {shortcut && <span className="text-muted-foreground">{shortcut}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
