import { useRef, useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from "react"
import { useEditor, EditorContent } from "@tiptap/react"
import { GapCursor } from "@tiptap/pm/gapcursor"
import type { ResolvedPos } from "@tiptap/pm/model"
import type { PluginKey } from "@tiptap/pm/state"
import { useParams } from "react-router-dom"
import { createEditorExtensions } from "./editor-extensions"
import { getDictationChunkPositions } from "./dictation-chunk-extension"
import { EditorBehaviors, isSuggestionActive } from "./editor-behaviors"
import { EditorToolbar } from "./editor-toolbar"
import { serializeToMarkdown, parseMarkdown, type MentionTypeLookup } from "./editor-markdown"
import {
  useMentionSuggestion,
  useChannelSuggestion,
  useCommandSuggestion,
  useEmojiSuggestion,
  useMemoSuggestion,
} from "./triggers"
import { parseMemoUrl } from "@/lib/memo-url"
import { MentionPluginKey } from "./triggers/mention-extension"
import { CommandPluginKey } from "./triggers/command-extension"
import { EmojiPluginKey } from "./triggers/emoji-extension"
import { shouldRemoveTriggerOnToggle, type SuggestionPluginState } from "./trigger-toggle"
import {
  handleBeforeInputAtomDelete,
  handleBeforeInputGraphemeDelete,
  handleBeforeInputKeyboardPaste,
  handleBeforeInputNewline,
  insertPastedText,
} from "./multiline-blocks"
import { useMentionables } from "@/hooks/use-mentionables"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { cn } from "@/lib/utils"
import { usePreferences } from "@/contexts"
import { getEffectiveEditorBindings } from "@/lib/keyboard-shortcuts"
import type { UploadResult } from "@/hooks/use-attachments"
import type { AttachmentReferenceAttrs } from "./attachment-reference-extension"
import type { MessageSendMode, JSONContent } from "@threa/types"
import type { MentionStreamContext } from "@/hooks/use-mentionables"

export interface RichEditorHandle {
  focus(): void
  focusAfterQuoteReply(): void
  insertMention(): void
  insertSlash(): void
  insertEmoji(): void
  /** Append a committed dictation span at the caret. */
  insertTranscribedText(text: string): void
  /** Show the live (uncommitted) dictation hypothesis as a caret ghost; empty string clears it. */
  setDictationInterim(text: string): void
  /**
   * Insert a polished dictation chunk and start tracking its range so it can
   * later be swapped (Show original / Show polished) or locked when the user
   * edits inside it.
   */
  insertDictationChunk(args: { chunkId: string; text: string }): void
  /**
   * Swap a tracked chunk's text in place. Returns true if the swap happened,
   * false if the chunk was missing or the user edited inside it (the chunk is
   * locked in that case and the swap is skipped).
   */
  replaceDictationChunkText(args: { chunkId: string; newText: string; expectedText: string }): boolean
  /** Drop tracking for a single chunk (leaves its text in the doc). */
  lockDictationChunk(args: { chunkId: string }): void
  /** Drop tracking for every chunk. */
  lockAllDictationChunks(): void
  /**
   * Read the live text currently inside a tracked chunk. Returns null if the
   * chunkId is no longer tracked (locked, never inserted, or already cleared).
   * The dictation hook uses this as the canonical `expectedText` for swap calls,
   * rather than maintaining a parallel prediction that drifts from the doc.
   */
  getDictationChunkText(chunkId: string): string | null
  /** Access the TipTap editor instance for external toolbar rendering */
  getEditor(): import("@tiptap/react").Editor | null
}

function isValidGapCursorPosition($pos: ResolvedPos): boolean {
  const gapCursor = GapCursor as typeof GapCursor & {
    valid?: (position: ResolvedPos) => boolean
  }

  return gapCursor.valid?.($pos) ?? false
}

interface RichEditorProps {
  value: JSONContent
  onChange: (json: JSONContent) => void
  onSubmit: () => void
  /** Called when files are pasted or dropped. Returns upload result for updating the node. */
  onFileUpload?: (file: File) => Promise<UploadResult>
  /** Current count of images for sequential naming of pasted images */
  imageCount?: number
  placeholder?: string
  disabled?: boolean
  className?: string
  /** How Enter key behaves: "enter" = Enter sends, "cmdEnter" = Cmd+Enter sends */
  messageSendMode?: MessageSendMode
  /** Auto-focus the editor when mounted */
  autoFocus?: boolean
  /** When this value changes, re-focus the editor (if autoFocus is enabled) */
  scopeId?: string
  /** Show the toolbar pinned inline above the editor (button-driven mode) */
  staticToolbarOpen?: boolean
  /** Disable the floating bubble toolbar triggered by text selection */
  disableSelectionToolbar?: boolean
  /** Called when ArrowUp is pressed in an empty editor — triggers edit-last-message */
  onEditLastMessage?: () => void
  /** Extra content rendered after the formatting buttons in the inline toolbar */
  toolbarTrailingContent?: React.ReactNode
  /** Content rendered between the toolbar and the editor (e.g. attachment pills) */
  belowToolbarContent?: React.ReactNode
  /** Accessible name announced for the editor surface */
  ariaLabel: string
  /** IDs of elements that describe the editor surface */
  ariaDescribedBy?: string
  /** Blur the editor when Escape is pressed and no suggestion popup is active */
  blurOnEscape?: boolean
  /** Called after Escape blurs the editor */
  onEscapeBlur?: () => void
  /** Stream context for filtering which broadcast mentions (@channel, @here) are available */
  streamContext?: MentionStreamContext
  /**
   * Access anchor for the `/memo` picker: the stream this editor composes into.
   * Scopes the picker to memos shareable into that stream so they can't be
   * embedded into — and leaked to — a stream they don't belong to. Pass the
   * current stream (thread or root); the backend resolves the thread root.
   */
  memoAnchorStreamId?: string
  /** Whether @mentions should be parsed and autocompleted. */
  enableMentions?: boolean
  /** Whether #channel references should be parsed and autocompleted. */
  enableChannels?: boolean
  /** Whether slash commands should be parsed and autocompleted. */
  enableCommands?: boolean
  /** Whether emoji shortcodes should be parsed and autocompleted. */
  enableEmoji?: boolean
  /** Whether `/memo` inline search and pasted memo links embed memo cards. */
  enableMemoEmbed?: boolean
}

function isEditorCompletelyEmpty(editor: import("@tiptap/react").Editor | null | undefined): boolean {
  if (!editor) {
    return false
  }

  const { doc } = editor.state
  return (
    doc.childCount === 1 &&
    !!doc.firstChild &&
    doc.firstChild.type.name === "paragraph" &&
    doc.firstChild.content.size === 0
  )
}

function emojiAtomToEditableText(node: JSONContent, toEmoji?: (shortcode: string) => string | null): JSONContent {
  if (node.type === "emoji") {
    const shortcode = typeof node.attrs?.shortcode === "string" ? node.attrs.shortcode : ""
    const emoji = typeof node.attrs?.emoji === "string" ? node.attrs.emoji : toEmoji?.(shortcode)
    return {
      type: "text",
      text: emoji ?? (shortcode ? `:${shortcode}:` : "\uFFFC"),
      marks: node.marks,
    }
  }

  if (!node.content) {
    return node
  }

  return {
    ...node,
    content: node.content.map((child) => emojiAtomToEditableText(child, toEmoji)),
  }
}

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  {
    value,
    onChange,
    onSubmit,
    onFileUpload,
    imageCount = 0,
    placeholder = "Type a message...",
    disabled = false,
    className,
    messageSendMode = "enter",
    autoFocus = false,
    scopeId,
    staticToolbarOpen = false,
    disableSelectionToolbar = false,
    onEditLastMessage,
    toolbarTrailingContent,
    belowToolbarContent,
    ariaLabel,
    ariaDescribedBy,
    blurOnEscape = false,
    onEscapeBlur,
    streamContext,
    memoAnchorStreamId,
    enableMentions = true,
    enableChannels = true,
    enableCommands = true,
    enableEmoji = true,
    enableMemoEmbed = true,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isInternalUpdate = useRef(false)
  const [isFocused, setIsFocused] = useState(false)
  const [hasSelection, setHasSelection] = useState(false)
  const [isInTable, setIsInTable] = useState(false)
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [toolbarVisible, setToolbarVisible] = useState(false)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Detect /invite mode from editor content so @mentions filter to inviteables only.
  const isInviteMode = useMemo(() => {
    if (!value || !value.content || value.content.length === 0) return false
    const firstBlock = value.content[0]
    const firstInline = firstBlock?.content?.[0]
    // Case 1: user selected /invite from the command dropdown (materialised node)
    if (firstInline?.type === "slashCommand" && firstInline.attrs?.name === "invite") return true
    // Case 2: user typed /invite as plain text (paragraph with text node)
    const firstText = firstInline?.text ?? ""
    return typeof firstText === "string" && /^\/invite\b/.test(firstText)
  }, [value])

  const mentionStreamContext = useMemo<MentionStreamContext | undefined>(() => {
    if (!streamContext) return undefined
    return { ...streamContext, inviteMode: isInviteMode }
  }, [streamContext, isInviteMode])

  // Mention, channel, command, and emoji autocomplete
  // Unfiltered for type-lookup: ensures all broadcast slugs always resolve correctly
  const { mentionables } = useMentionables()
  // Filtered for autocomplete dropdown only
  const { suggestionConfig: mentionConfig, renderMentionList } = useMentionSuggestion(mentionStreamContext)
  const { suggestionConfig: channelConfig, renderChannelList } = useChannelSuggestion()
  const { suggestionConfig: commandConfig, renderCommandList } = useCommandSuggestion({
    includeMemoSearch: enableMemoEmbed,
  })
  const { suggestionConfig: memoConfig, renderMemoList } = useMemoSuggestion(memoAnchorStreamId)

  // Emoji autocomplete
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { emojis, emojiWeights, toEmoji } = useWorkspaceEmoji(workspaceId ?? "")
  const { suggestionConfig: emojiConfig, renderEmojiGrid } = useEmojiSuggestion({ emojis, emojiWeights })

  // Create lookup for mention types from mentionables
  // Current user's slug maps to "me" for special highlighting
  const getMentionType = useMemo<MentionTypeLookup>(() => {
    const slugToType = new Map<string, "user" | "persona" | "bot" | "broadcast" | "me">()
    for (const m of mentionables) {
      // Map current user to "me" type for special highlighting
      slugToType.set(m.slug, m.isCurrentUser ? "me" : m.type)
    }
    return (slug: string) => slugToType.get(slug) ?? "user"
  }, [mentionables])

  // Ref to avoid stale closure in TipTap paste handler
  const getMentionTypeRef = useRef(getMentionType)
  getMentionTypeRef.current = getMentionType
  const toEmojiRef = useRef(toEmoji)
  toEmojiRef.current = toEmoji
  const markdownParseOptions = useMemo(
    () => ({
      enableMentions,
      enableChannels,
      enableSlashCommands: enableCommands,
      enableEmoji,
      emojiAsText: true,
    }),
    [enableMentions, enableChannels, enableCommands, enableEmoji]
  )
  const editableValue = useMemo(
    () => emojiAtomToEditableText(value, enableEmoji ? toEmoji : undefined),
    [value, enableEmoji, toEmoji]
  )

  // Ref to avoid stale closure for file upload callback
  const onFileUploadRef = useRef(onFileUpload)
  onFileUploadRef.current = onFileUpload

  // Ignore upload completions that resolve after the editor has switched scope.
  const uploadScopeVersionRef = useRef(0)
  const uploadScopeIdRef = useRef(scopeId)
  if (uploadScopeIdRef.current !== scopeId) {
    uploadScopeIdRef.current = scopeId
    uploadScopeVersionRef.current += 1
  }

  // Ref to access current image count for paste renaming
  const imageCountRef = useRef(imageCount)
  imageCountRef.current = imageCount

  // Refs for editor behaviors to avoid stale closures in keyboard shortcuts
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit
  const messageSendModeRef = useRef(messageSendMode)
  messageSendModeRef.current = messageSendMode
  const onEditLastMessageRef = useRef(onEditLastMessage)
  onEditLastMessageRef.current = onEditLastMessage
  const onEscapeBlurRef = useRef(onEscapeBlur)
  onEscapeBlurRef.current = onEscapeBlur

  // Effective editor formatting bindings (updated reactively, read by ref to avoid editor re-creation)
  const { preferences } = usePreferences()
  const customBindings = preferences?.keyboardShortcuts ?? {}
  const effectiveEditorBindings = useMemo(() => getEffectiveEditorBindings(customBindings), [customBindings])
  const keyBindingsRef = useRef<Record<string, string>>({})
  keyBindingsRef.current = effectiveEditorBindings

  // Ref to access editor instance from callbacks defined before useEditor returns
  const editorRef = useRef<ReturnType<typeof useEditor>>(null)

  // Track mentionables state to detect when data loads or currentUser becomes known
  const lastParsedState = useRef({ count: mentionables.length, hasCurrentUser: false })
  const pendingMentionReparse = useRef(false)
  // Extensions are memoized but DON'T depend on messageSendMode/onSubmit
  // because we pass refs that get updated on render
  const extensions = useMemo(
    () => [
      ...createEditorExtensions({
        placeholder,
        mentionSuggestion: enableMentions ? mentionConfig : undefined,
        channelSuggestion: enableChannels ? channelConfig : undefined,
        commandSuggestion: enableCommands ? commandConfig : undefined,
        emojiSuggestion: enableEmoji ? emojiConfig : undefined,
        memoSearchSuggestion: enableMemoEmbed ? memoConfig : undefined,
        toEmoji: enableEmoji ? toEmoji : undefined,
      }),
      EditorBehaviors.configure({
        sendModeRef: messageSendModeRef,
        onSubmitRef: onSubmitRef,
        keyBindingsRef: keyBindingsRef,
      }),
    ],
    [
      placeholder,
      mentionConfig,
      channelConfig,
      commandConfig,
      emojiConfig,
      memoConfig,
      toEmoji,
      enableMentions,
      enableChannels,
      enableCommands,
      enableEmoji,
      enableMemoEmbed,
    ]
  )

  // Debounced toolbar visibility — show only when focused with selection, or
  // when link/dropdown is open (keeps toolbar alive while interacting with it).
  // Suppressed when the inline toolbar is open (button-driven mode) or when
  // selection-driven toolbar is disabled (e.g. mobile, where OS selection
  // popup conflicts with the floating bubble).
  const shouldBeVisible =
    !staticToolbarOpen &&
    !disableSelectionToolbar &&
    ((isFocused && hasSelection) || (isFocused && isInTable) || linkPopoverOpen || dropdownOpen)
  useEffect(() => {
    if (shouldBeVisible) {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
        hideTimeoutRef.current = null
      }
      setToolbarVisible(true)
    } else {
      hideTimeoutRef.current = setTimeout(() => {
        setToolbarVisible(false)
      }, 150)
    }
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
      }
    }
  }, [shouldBeVisible])

  // Helper to handle file insertion from paste or drop
  const handleFileInsert = useCallback(async (file: File, editorInstance: ReturnType<typeof useEditor>) => {
    const uploadFn = onFileUploadRef.current
    if (!uploadFn || !editorInstance) return
    const uploadScopeVersion = uploadScopeVersionRef.current

    const isImage = file.type.startsWith("image/")
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`

    // Insert placeholder node
    const placeholderAttrs: AttachmentReferenceAttrs = {
      id: tempId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      status: "uploading",
      imageIndex: null, // Will be set after upload
      error: null,
    }

    editorInstance.commands.insertAttachmentReference(placeholderAttrs)

    // Caller is fire-and-forget (paste/drop loops), so swallow the rejection
    // here and surface it through the placeholder's error state instead of
    // leaving the node stuck in "uploading" indefinitely.
    const isStillTargeting = () =>
      uploadScopeVersion === uploadScopeVersionRef.current &&
      !editorInstance.isDestroyed &&
      editorRef.current === editorInstance

    try {
      const result = await uploadFn(file)
      if (!isStillTargeting()) return
      editorInstance.commands.updateAttachmentReference(tempId, {
        id: result.attachment.id,
        status: result.attachment.status,
        imageIndex: isImage ? result.imageIndex : null,
        error: result.attachment.error || null,
      })
    } catch (err) {
      if (!isStillTargeting()) return
      editorInstance.commands.updateAttachmentReference(tempId, {
        status: "error",
        error: err instanceof Error ? err.message : "Upload failed",
      })
    }
  }, [])

  const editor = useEditor({
    extensions,
    content: editableValue,
    editable: !disabled,
    autofocus: autoFocus ? "end" : false,
    onUpdate: ({ editor }) => {
      if (isInternalUpdate.current) return
      onChange(editor.getJSON())
    },
    onFocus: () => setIsFocused(true),
    onBlur: () => {
      setIsFocused(false)
      // Safety net: reset any stuck dropdown state when editor loses focus.
      // On desktop, Radix's DropdownMenuTrigger calls preventDefault on pointerdown
      // to prevent editor blur when opening the StylePicker, so this only fires on
      // true focus loss. On mobile it prevents the toolbar getting stuck open if
      // blur precedes Radix's onOpenChange(false) due to event ordering differences.
      setDropdownOpen(false)
    },
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        ...(ariaDescribedBy ? { "aria-describedby": ariaDescribedBy } : {}),
        class: cn(
          "min-h-[40px] max-h-[200px] overflow-y-auto w-full py-2 outline-none",
          "prose prose-sm dark:prose-invert max-w-none text-sm",
          // Paragraph styling - minimal spacing for chat-like feel
          "[&_p]:my-0 [&_p]:min-h-[1.5em]",
          // List styling
          "[&_ul]:my-1 [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:pl-5",
          "[&_li]:my-0 [&_li]:pl-0.5",
          // Code block styling
          "[&_pre]:my-2 [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3",
          "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
          // Blockquote styling
          "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/30 [&_blockquote]:pl-4 [&_blockquote]:italic",
          // Heading styling
          "[&_h1]:text-xl [&_h1]:font-bold [&_h1]:my-2",
          "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:my-1.5",
          "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:my-1",
          "focus:outline-none"
        ),
      },
      handlePaste: (_view, event) => {
        // Check for files first (images, documents, etc.)
        const files = event.clipboardData?.files
        if (files && files.length > 0 && onFileUploadRef.current && editorRef.current) {
          event.preventDefault()
          const fileArray = Array.from(files)
          let pasteImageOffset = 0
          for (const file of fileArray) {
            let fileToInsert = file
            // Rename pasted images to sequential names (pasted-image-1.png, etc.)
            if (file.type.startsWith("image/")) {
              pasteImageOffset++
              const nextIndex = imageCountRef.current + pasteImageOffset
              const ext = file.name.split(".").pop() || "png"
              const newName = `pasted-image-${nextIndex}.${ext}`
              fileToInsert = new File([file], newName, { type: file.type })
            }
            handleFileInsert(fileToInsert, editorRef.current)
          }
          return true
        }

        // Parse pasted text through markdown parser to convert @mentions, #channels, :emoji:
        const text = event.clipboardData?.getData("text/plain")
        if (!text || !editorRef.current) {
          return false
        }

        // A bare memo link pastes as an embed card rather than a plain URL.
        if (enableMemoEmbed) {
          const memoId = parseMemoUrl(text.trim())
          if (memoId) {
            editorRef.current.commands.insertMemoEmbed({ memoId })
            event.preventDefault()
            return true
          }
        }

        const handled = insertPastedText(
          editorRef.current,
          text,
          enableMentions ? getMentionTypeRef.current : undefined,
          enableEmoji ? toEmojiRef.current : undefined,
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
          if (isSuggestionActive(editor)) return false

          // Android atom deletion: keymap doesn't fire for Backspace, so delete
          // adjacent inline atoms here before the browser's two-step selection.
          if (handleBeforeInputAtomDelete(editor, event as InputEvent)) {
            return true
          }

          // Firefox Android can delete emoji text by code unit, leaving a
          // broken half-grapheme. Delete the whole grapheme before native input.
          if (handleBeforeInputGraphemeDelete(editor, event as InputEvent)) {
            return true
          }

          // Gboard / SwiftKey clipboard-bar paste arrives as insertText, not paste.
          if (
            handleBeforeInputKeyboardPaste(
              editor,
              event as InputEvent,
              enableMentions ? getMentionTypeRef.current : undefined,
              enableEmoji ? toEmojiRef.current : undefined,
              markdownParseOptions
            )
          ) {
            return true
          }

          // Newline handling only matters in cmdEnter mode (Enter sends in default mode).
          if (messageSendModeRef.current !== "cmdEnter") return false
          return handleBeforeInputNewline(editor, event as InputEvent)
        },
      },
      handleDrop: (_view, event, _slice, moved) => {
        // Internal drag-and-drop (reordering) - let TipTap handle it
        if (moved) return false

        // Check for dropped files
        const files = event.dataTransfer?.files
        if (files && files.length > 0 && onFileUploadRef.current && editorRef.current) {
          event.preventDefault()
          for (const file of Array.from(files)) {
            handleFileInsert(file, editorRef.current)
          }
          return true
        }
        return false
      },
      handleKeyDown: (_view, event) => {
        const currentEditor = editorRef.current

        if (event.key === "Escape" && blurOnEscape) {
          if (currentEditor && isSuggestionActive(currentEditor)) {
            return false
          }
          event.preventDefault()
          ;(_view.dom as HTMLElement).blur()
          onEscapeBlurRef.current?.()
          return true
        }
        // ArrowUp in empty editor: edit the last message sent by the current user
        if (
          event.key === "ArrowUp" &&
          isEditorCompletelyEmpty(currentEditor) &&
          !(currentEditor && isSuggestionActive(currentEditor)) &&
          onEditLastMessageRef.current
        ) {
          event.preventDefault()
          onEditLastMessageRef.current()
          return true
        }
        // Cmd/Ctrl+Enter: always send (regardless of mode or active suggestions)
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
          event.preventDefault()
          onSubmitRef.current()
          return true
        }
        // Enter in "enter" send mode: send unless a suggestion popup is active
        if (event.key === "Enter" && !event.shiftKey && messageSendModeRef.current === "enter") {
          if (currentEditor && isSuggestionActive(currentEditor)) {
            return false // Let suggestion popup handle Enter
          }
          event.preventDefault()
          onSubmitRef.current()
          return true
        }
        // Shift+Cmd/Ctrl+V to paste as plain text (no mention parsing)
        if (event.key === "v" && event.shiftKey && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          navigator.clipboard
            .readText()
            .then((text) => {
              editorRef.current?.commands.insertContent(text)
            })
            .catch(() => {
              // Clipboard access denied or unavailable - silently fail
            })
          return true
        }
        return false
      },
    },
  })

  // Store editor in ref so callbacks defined inside useEditor options can access it
  editorRef.current = editor

  // Track whether the editor has a non-empty selection (drives toolbar visibility)
  // and whether the cursor is inside a table (keeps the table controls reachable
  // even with a collapsed caret, since you can't "select" a table to reveal them).
  useEffect(() => {
    if (!editor) return
    const updateSelection = () => {
      setHasSelection(!editor.state.selection.empty)
      setIsInTable(editor.isActive("table"))
    }
    editor.on("selectionUpdate", updateSelection)
    editor.on("update", updateSelection)
    return () => {
      editor.off("selectionUpdate", updateSelection)
      editor.off("update", updateSelection)
    }
  }, [editor])

  // Sync external value changes (e.g., draft restoration, clearing after send)
  useEffect(() => {
    if (!editor || editor.isDestroyed) return

    // Compare JSON content - use string comparison for simplicity
    const currentJson = JSON.stringify(editor.getJSON())
    const newJson = JSON.stringify(editableValue)
    if (newJson !== currentJson) {
      const hadFocus = editor.isFocused
      isInternalUpdate.current = true
      editor.commands.setContent(editableValue)
      isInternalUpdate.current = false
      // Mobile browsers can drop focus when contenteditable content is replaced.
      // Restore it to keep the virtual keyboard open.
      if (hadFocus && !editor.isFocused) {
        editor.commands.focus()
      }
    }
  }, [editableValue, editor])

  // Re-parse content when mentionables load or currentUser becomes known (for correct mention type colors)
  useEffect(() => {
    if (!editor || editor.isDestroyed) return

    const hasCurrentUser = mentionables.some((m) => m.isCurrentUser)
    const current = { count: mentionables.length, hasCurrentUser }

    // Re-parse if:
    // 1. More mentionables loaded than last time, OR
    // 2. We now have current user info but didn't before
    const shouldReparseForStructuredTokens = enableMentions || enableChannels || enableCommands || enableEmoji

    const shouldReparse =
      shouldReparseForStructuredTokens &&
      (pendingMentionReparse.current ||
        current.count > lastParsedState.current.count ||
        (current.hasCurrentUser && !lastParsedState.current.hasCurrentUser))

    if (shouldReparse) {
      lastParsedState.current = current
      // Replacing editor content while the user is actively typing can drop
      // the first keystrokes after reload. Defer this cosmetic reparse until
      // focus leaves the editor so mention colors still update without clobbering input.
      if (isFocused || editor.isFocused) {
        pendingMentionReparse.current = true
        return
      }
      pendingMentionReparse.current = false
      // Round-trip through markdown to update mention types with new user data
      const markdown = serializeToMarkdown(editor.getJSON())
      if (markdown) {
        isInternalUpdate.current = true
        editor.commands.setContent(
          parseMarkdown(
            markdown,
            enableMentions ? getMentionType : undefined,
            enableEmoji ? toEmoji : undefined,
            markdownParseOptions
          )
        )
        isInternalUpdate.current = false
      }
    }
  }, [
    editor,
    mentionables,
    getMentionType,
    toEmoji,
    isFocused,
    enableMentions,
    enableChannels,
    enableCommands,
    enableEmoji,
    markdownParseOptions,
  ])

  // TipTap's autofocus option handles initial focus.
  // No additional focus-on-mount effect needed — the redundant focus()
  // dispatch caused a view update that raced with toolbar rendering,
  // briefly dropping focus in autoFocus editors (e.g. inline edit).

  // Copy/cut handler: serialize selection to markdown
  useEffect(() => {
    if (!editor || !containerRef.current) return

    const serializeSelection = (event: ClipboardEvent) => {
      const { from, to } = editor.state.selection
      if (from === to) return // No selection, use default behavior

      const slice = editor.state.doc.slice(from, to)
      const json = { type: "doc", content: slice.content.toJSON() }
      const markdown = serializeToMarkdown(json)

      event.clipboardData?.setData("text/plain", markdown)
      event.preventDefault()
    }

    const handleCopy = (event: ClipboardEvent) => {
      serializeSelection(event)
    }

    const handleCut = (event: ClipboardEvent) => {
      serializeSelection(event)
      // Delete the selected content after serializing to clipboard
      editor.commands.deleteSelection()
    }

    const container = containerRef.current
    container.addEventListener("copy", handleCopy)
    container.addEventListener("cut", handleCut)
    return () => {
      container.removeEventListener("copy", handleCopy)
      container.removeEventListener("cut", handleCut)
    }
  }, [editor])

  // Expose focus method
  const focus = useCallback(() => {
    if (editor && !editor.isDestroyed) {
      editor.commands.focus("end")
    }
  }, [editor])

  const focusAfterQuoteReply = useCallback(() => {
    if (!editor || editor.isDestroyed) {
      return
    }

    const pos = editor.state.doc.content.size
    const $pos = editor.state.doc.resolve(pos)

    if (isValidGapCursorPosition($pos)) {
      editor.view.focus()
      editor.view.dispatch(editor.state.tr.setSelection(new GapCursor($pos)).scrollIntoView())
      return
    }

    editor.commands.focus("end")
  }, [editor])

  // Re-focus when scope changes (e.g., navigating between streams) on desktop.
  // TipTap's autofocus only fires on mount; without key={scopeId} remounting,
  // we need to manually re-focus when the scope changes.
  const prevScopeRef = useRef(scopeId)
  useEffect(() => {
    const prev = prevScopeRef.current
    prevScopeRef.current = scopeId
    if (autoFocus && prev !== undefined && prev !== scopeId) {
      const timer = setTimeout(() => focus(), 0)
      return () => clearTimeout(timer)
    }
  }, [scopeId, autoFocus, focus])

  // Re-focus after external disabled transitions (e.g., stream un-archived).
  // Only fires on true→false transitions — mount is excluded so we don't
  // race with TipTap's autofocus option.
  const prevDisabledRef = useRef(disabled)
  useEffect(() => {
    const wasDisabled = prevDisabledRef.current
    prevDisabledRef.current = disabled
    if (wasDisabled && !disabled && editor && !editor.isDestroyed) {
      const timer = setTimeout(() => focus(), 0)
      return () => clearTimeout(timer)
    }
  }, [disabled, editor, focus])

  // Trigger icon behavior:
  // - First click inserts trigger character and opens suggestion popup.
  // - Second click (while still empty) removes that trigger character.
  const handleTriggerClick = useCallback(
    (trigger: string, pluginKey: PluginKey) => {
      if (!editor) return

      const { selection } = editor.state
      const suggestionState = pluginKey.getState(editor.state) as SuggestionPluginState | null

      if (
        shouldRemoveTriggerOnToggle(trigger, suggestionState, {
          from: selection.from,
          to: selection.to,
          empty: selection.empty,
        })
      ) {
        editor
          .chain()
          .focus()
          .deleteRange({ from: selection.from - trigger.length, to: selection.from })
          .run()
        return
      }

      editor.chain().focus().insertContent(trigger).run()
    },
    [editor]
  )

  const handleMentionClick = useCallback(() => {
    handleTriggerClick("@", MentionPluginKey)
  }, [handleTriggerClick])

  const handleSlashClick = useCallback(() => {
    handleTriggerClick("/", CommandPluginKey)
  }, [handleTriggerClick])

  const handleEmojiClick = useCallback(() => {
    handleTriggerClick(":", EmojiPluginKey)
  }, [handleTriggerClick])

  const insertTranscribedText = useCallback(
    (text: string) => {
      if (!editor || editor.isDestroyed || !text) return
      // Separate consecutive committed spans with a space when the caret isn't
      // already on whitespace, so words don't run together.
      const { from } = editor.state.selection
      const charBefore = from > 0 ? editor.state.doc.textBetween(from - 1, from) : ""
      const prefix = charBefore && !/\s/.test(charBefore) ? " " : ""
      editor.chain().focus().insertContent(`${prefix}${text}`).run()
    },
    [editor]
  )

  const setDictationInterim = useCallback(
    (text: string) => {
      if (!editor || editor.isDestroyed) return
      editor.commands.setDictationPreview(text)
    },
    [editor]
  )

  const insertDictationChunk = useCallback(
    ({ chunkId, text }: { chunkId: string; text: string }) => {
      if (!editor || editor.isDestroyed || !text) return
      editor.chain().focus().insertDictationChunk({ chunkId, text }).run()
    },
    [editor]
  )

  const replaceDictationChunkText = useCallback(
    ({ chunkId, newText, expectedText }: { chunkId: string; newText: string; expectedText: string }) => {
      if (!editor || editor.isDestroyed) return false
      return editor.chain().replaceDictationChunkText({ chunkId, newText, expectedText }).run()
    },
    [editor]
  )

  const lockDictationChunk = useCallback(
    ({ chunkId }: { chunkId: string }) => {
      if (!editor || editor.isDestroyed) return
      editor.chain().lockDictationChunk({ chunkId }).run()
    },
    [editor]
  )

  const lockAllDictationChunks = useCallback(() => {
    if (!editor || editor.isDestroyed) return
    editor.chain().lockAllDictationChunks().run()
  }, [editor])

  const getDictationChunkText = useCallback(
    (chunkId: string): string | null => {
      if (!editor || editor.isDestroyed) return null
      const positions = getDictationChunkPositions(editor.state)
      return positions.find((c) => c.chunkId === chunkId)?.text ?? null
    },
    [editor]
  )

  // Expose imperative handle for parent to trigger insert actions
  useImperativeHandle(
    ref,
    () => ({
      focus,
      focusAfterQuoteReply,
      insertMention: handleMentionClick,
      insertSlash: handleSlashClick,
      insertEmoji: handleEmojiClick,
      insertTranscribedText,
      setDictationInterim,
      insertDictationChunk,
      replaceDictationChunkText,
      lockDictationChunk,
      lockAllDictationChunks,
      getDictationChunkText,
      getEditor: () => editor,
    }),
    [
      focus,
      focusAfterQuoteReply,
      handleMentionClick,
      handleSlashClick,
      handleEmojiClick,
      insertTranscribedText,
      setDictationInterim,
      insertDictationChunk,
      replaceDictationChunkText,
      lockDictationChunk,
      lockAllDictationChunks,
      getDictationChunkText,
      editor,
    ]
  )

  return (
    <div ref={containerRef} className={cn("relative flex-1", disabled && "cursor-not-allowed opacity-50", className)}>
      <EditorToolbar
        editor={editor}
        isVisible={staticToolbarOpen || toolbarVisible}
        inline={staticToolbarOpen}
        linkPopoverOpen={linkPopoverOpen}
        onLinkPopoverOpenChange={setLinkPopoverOpen}
        onDropdownOpenChange={setDropdownOpen}
        trailingContent={staticToolbarOpen ? toolbarTrailingContent : undefined}
      />
      {belowToolbarContent}
      <EditorContent editor={editor} />
      {enableMentions ? renderMentionList() : null}
      {enableChannels ? renderChannelList() : null}
      {enableCommands ? renderCommandList() : null}
      {enableEmoji ? renderEmojiGrid() : null}
      {enableMemoEmbed ? renderMemoList() : null}
    </div>
  )
})
