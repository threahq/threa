import { useRef, useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from "react"
import { useEditor, EditorContent } from "@tiptap/react"
import { GapCursor } from "@tiptap/pm/gapcursor"
import type { ResolvedPos } from "@tiptap/pm/model"
import type { PluginKey } from "@tiptap/pm/state"
import { useParams } from "react-router-dom"
import { ComposerPillDndProvider } from "./composer-pill-dnd"
import { countAttachmentReferences } from "./attachment-reference-counts"
import { buildImageIndexByAttachment } from "@/components/timeline/attachment-image-index"
import { findUploadJob } from "@/lib/uploads/upload-manager"
import { createEditorExtensions } from "./editor-extensions"
import { applyExternalEditorContent } from "./apply-external-content"
import { ComposerPillCopyButton } from "./composer-pill-copy-button"
import { getDictationChunkPositions } from "./dictation-chunk-extension"
import { EditorBehaviors, isSuggestionActive } from "./editor-behaviors"
import { EditorToolbar } from "./editor-toolbar"
import {
  serializeToMarkdown,
  parseMarkdown,
  isProseMirrorClipboardEvent,
  type MentionTypeLookup,
} from "./editor-markdown"
import { serializeClipboardSlice } from "./clipboard-copy"
import { insertPlainText, isPlainTextPaste } from "./plain-text-paste"
import { handleBeforeInputLinkPaste, pasteLinkOverSelection } from "./paste-link-over-selection"
import {
  useMentionSuggestion,
  useChannelSuggestion,
  useCommandSuggestion,
  useEmojiSuggestion,
  useMemoSuggestion,
  useCommandArgPicker,
  useAttachmentPicker,
  findPickableArg,
} from "./triggers"
import type { CommandItem } from "./triggers/types"
import { parseMemoUrl } from "@/lib/memo-url"
import { getPerfCapture } from "@/lib/perf/capture"
import { classifyDraftLink } from "@/lib/in-app-links"
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
import { useGiphyEnabled } from "@/hooks/use-giphy-enabled"
import { GiphyPickerDialog } from "./giphy-picker-dialog"
import { SnippetEditorDialog } from "./snippet-editor-dialog"
import {
  shouldConvertPasteToSnippet,
  defaultSnippetFilename,
  detectSnippetFormat,
  snippetMimeForFilename,
  SNIPPET_FALLBACK_FILENAME,
} from "./snippet-paste"
import type { GiphyGif } from "@threa/types"
import { cn } from "@/lib/utils"
import { usePreferences } from "@/contexts"
import { getEffectiveEditorBindings } from "@/lib/keyboard-shortcuts"
import type { PendingAttachment, UploadResult } from "@/hooks/use-attachments"
import type { AttachmentReferenceAttrs } from "./attachment-reference-extension"
import type {
  MessageSendMode,
  JSONContent,
  VoiceReplacementAckStatus,
  VoiceTranscriptReplacementSourceV4,
} from "@threa/types"
import type { MentionStreamContext } from "@/hooks/use-mentionables"

export interface RichEditorHandle {
  focus(): void
  focusAfterQuoteReply(): void
  insertMention(): void
  insertSlash(): void
  insertEmoji(): void
  /** Open the snippet editor with an empty draft anchored at the caret. */
  openSnippetEditor(): void
  /** Upload files and insert their reference chips at the current selection. */
  insertFiles(files: File[]): boolean
  /** Drop the `/attachment` upload anchor so an abandoned pick can't hijack the next one. */
  cancelPendingInlineUpload(): void
  /** Delete every inline reference to one attachment (the delete cascade). */
  removeAttachmentReferences(attachmentId: string): void
  /** Append a committed dictation span at the caret. */
  insertTranscribedText(text: string, options?: { joinPrevious?: boolean }): void
  /** Show the live (uncommitted) dictation hypothesis as a caret ghost; empty string clears it. */
  setDictationInterim(text: string): void
  /**
   * Insert a polished dictation chunk and start tracking its range so it can
   * later be swapped (Show original / Show polished) or locked when the user
   * edits inside it.
   */
  insertDictationChunk(args: {
    chunkId: string
    contentJson: JSONContent
    afterChunkId?: string
    joinPrevious?: boolean
  }): boolean
  /**
   * Swap a tracked chunk's text in place. Returns true if the swap happened,
   * false if the chunk was missing or the user edited inside it (the chunk is
   * locked in that case and the swap is skipped).
   */
  replaceDictationChunk?(args: { chunkId: string; contentJson: JSONContent }): boolean
  replaceDictationChunks?(args: {
    sources: VoiceTranscriptReplacementSourceV4[]
    resultChunkId: string
    contentJson: JSONContent
  }): VoiceReplacementAckStatus
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
  getDictationChunkContent?(chunkId: string): JSONContent | null
  /** Access the TipTap editor instance for external toolbar rendering */
  getEditor(): import("@tiptap/react").Editor | null
}

const NO_TRAY_ATTACHMENTS: readonly PendingAttachment[] = []

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
  /** Called when the editor gains focus. Fires on every focus, not only the first. */
  onFocus?: () => void
  /** Stream context for filtering which broadcast mentions (@channel, @here) are available */
  streamContext?: MentionStreamContext
  /**
   * Access anchor for the `/memo` picker: the stream this editor composes into.
   * Scopes the picker to memos shareable into that stream so they can't be
   * embedded into — and leaked to — a stream they don't belong to. Pass the
   * current stream (thread or root); the backend resolves the thread root.
   */
  memoAnchorStreamId?: string
  /**
   * Scopes the `/` command palette to a stream the route can't name (the
   * conversation panel is a `?panel=conv:` overlay). Supplying it at all — even
   * as `null` — takes the route's `:streamId` out of play, so a panel over an
   * unrelated stream can't inherit that stream's runtime commands.
   */
  commandStreamId?: string | null
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
  /**
   * The composer's current attachment tray. `/attachment` lists these, so a file
   * already attached can be placed at the caret without a pointer.
   */
  trayAttachments?: readonly PendingAttachment[]
  /**
   * Open the composer's file picker for the `/attachment` command's "Upload a
   * file…" entry. The chosen files upload and insert through the same path a
   * paste or drop uses; the host clicks its existing hidden file input.
   */
  onRequestFileUpload?: () => void
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

/**
 * Convert a bare in-app stream/message/conversation URL into an inline chip,
 * replacing the link text. Shared by the clipboard `paste` path and the
 * Gboard/SwiftKey `beforeinput` path so mobile clipboard-bar pastes chip the same
 * as desktop. Returns whether a chip was inserted. A conversation link carries no
 * streamId — the node-view resolves it by URL.
 */
function tryInsertInAppLinkChip(editor: import("@tiptap/react").Editor, text: string): boolean {
  const ref = classifyDraftLink(text.trim())
  if (!ref || (ref.kind !== "stream" && ref.kind !== "message" && ref.kind !== "conversation")) return false
  editor.commands.insertInAppLink({
    url: ref.url,
    streamId: ref.kind === "conversation" ? null : ref.streamId,
    messageId: ref.kind === "message" ? ref.messageId : null,
  })
  return true
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
    onFocus: onFocusProp,
    streamContext,
    memoAnchorStreamId,
    commandStreamId,
    enableMentions = true,
    enableChannels = true,
    enableCommands = true,
    enableEmoji = true,
    enableMemoEmbed = true,
    trayAttachments,
    onRequestFileUpload,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isInternalUpdate = useRef(false)
  // Retry trigger + bounded counter for the external-value sync below. If
  // applying restored content throws, we re-run the sync on the next frame so
  // the body still lands rather than leaving the composer blank over a draft
  // that the restore already checked out of the stash (the "dead until refresh"
  // draft-restore failure).
  const [externalSyncNonce, setExternalSyncNonce] = useState(0)
  const externalSyncFailuresRef = useRef(0)
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

  const { workspaceId } = useParams<{ workspaceId: string }>()

  // `/giphy` is available wherever slash commands are enabled and the backend
  // has a Giphy key configured. The picker opens from the slash palette and
  // inserts an inline embed rendered from Giphy's CDN (no upload involved).
  const giphyEnabled = useGiphyEnabled(workspaceId) && enableCommands
  const [giphyOpen, setGiphyOpen] = useState(false)

  // A large paste opens the snippet editor instead of inserting inline; on save
  // it becomes a `.txt` attachment chip at the original paste position. The
  // draft holds the pasted text + suggested filename; the caret position and a
  // per-session counter live in refs so they don't re-render the editor.
  const [snippetDraft, setSnippetDraft] = useState<{ text: string; filename: string } | null>(null)
  const snippetInsertPosRef = useRef<number | null>(null)
  // Where an `/attachment` → "Upload a file…" pick must land: captured when the
  // host's file input is opened, consumed by the insert once files come back.
  const pendingUploadInsertPosRef = useRef<number | null>(null)
  const snippetCountRef = useRef(0)
  // Snippet creation needs an upload handler to attach through, same as the
  // paste path; gate the `/snippet` command on it too.
  const snippetEnabled = !!onFileUpload && enableCommands
  // `/attachment` is worth showing when there's something to place — any tray
  // file (uploading and failed included; a reference binds the id, not finished
  // bytes) — or an upload path to produce one.
  const canUploadFromPicker = !!onFileUpload && !!onRequestFileUpload
  const attachmentCommandEnabled = enableCommands && (canUploadFromPicker || (trayAttachments ?? []).length > 0)

  // Open the snippet editor with an empty draft, anchored at the caret so the
  // chip lands where it would for a paste. Shared by the `/snippet` command and
  // the command-palette action (exposed on the imperative handle below).
  const openSnippetEditor = useCallback(() => {
    const editorInstance = editorRef.current
    if (!editorInstance || !onFileUploadRef.current) return
    snippetInsertPosRef.current = editorInstance.state.selection.from
    snippetCountRef.current += 1
    setSnippetDraft({ text: "", filename: defaultSnippetFilename(snippetCountRef.current) })
  }, [])

  const openAttachmentPickerRef = useRef<() => void>(() => {})
  const openAttachmentPicker = useCallback(() => openAttachmentPickerRef.current(), [])

  // Stable bridge to the command-argument picker: held in a ref because the
  // picker (which owns `openArgPicker`) is set up after the editor exists,
  // while the command suggestion that fires it is wired up here.
  const onCommandPickedRef = useRef<(item: CommandItem) => void>(() => {})
  const notifyCommandPicked = useCallback((item: CommandItem) => onCommandPickedRef.current(item), [])

  // Unfiltered for type-lookup: ensures all broadcast slugs always resolve correctly
  const { mentionables } = useMentionables()
  // Filtered for autocomplete dropdown only
  const { suggestionConfig: mentionConfig, renderMentionList } = useMentionSuggestion(mentionStreamContext)
  const { suggestionConfig: channelConfig, renderChannelList } = useChannelSuggestion()
  const {
    suggestionConfig: commandConfig,
    renderCommandList,
    isKnownCommand: isKnownSlashCommand,
  } = useCommandSuggestion({
    includeMemoSearch: enableMemoEmbed,
    includeGiphy: giphyEnabled,
    includeSnippet: snippetEnabled,
    includeAttachment: attachmentCommandEnabled,
    onOpenGiphy: () => setGiphyOpen(true),
    onOpenSnippet: openSnippetEditor,
    onOpenAttachment: openAttachmentPicker,
    onCommandPicked: notifyCommandPicked,
    commandStreamId,
  })
  const { suggestionConfig: memoConfig, renderMemoList } = useMemoSuggestion(memoAnchorStreamId)

  const { emojis, emojiWeights, toEmoji } = useWorkspaceEmoji(workspaceId ?? "")
  const { suggestionConfig: emojiConfig, renderEmojiGrid } = useEmojiSuggestion({ emojis, emojiWeights })

  // Current user's slug maps to "me" for special highlighting.
  const getMentionType = useMemo<MentionTypeLookup>(() => {
    const slugToType = new Map<string, "user" | "persona" | "bot" | "broadcast" | "me">()
    for (const m of mentionables) {
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
      // Pasted markdown only becomes a command node for a real command; a
      // stray `/User` from a filepath stays text.
      isKnownCommand: enableCommands ? isKnownSlashCommand : undefined,
      enableEmoji,
      emojiAsText: true,
    }),
    [enableMentions, enableChannels, enableCommands, enableEmoji, isKnownSlashCommand]
  )
  // Same stale-closure guard as the refs above: the paste / beforeinput handlers
  // live in TipTap's `editorProps` (set once), but these options change when the
  // command set does, so the handlers must read the latest via the ref.
  const markdownParseOptionsRef = useRef(markdownParseOptions)
  markdownParseOptionsRef.current = markdownParseOptions
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
  const onFocusRef = useRef(onFocusProp)

  // Argument option picker (e.g. `/model` → choose a model). Opens after a
  // command with advertised `args[].suggestions` is inserted; its keys are
  // routed through editorProps.handleKeyDown below so it preempts send/blur.
  const { openArgPicker, renderArgPicker, handleArgPickerKeyDown } = useCommandArgPicker(editorRef)
  const argPickerKeyDownRef = useRef(handleArgPickerKeyDown)
  argPickerKeyDownRef.current = handleArgPickerKeyDown
  onCommandPickedRef.current = (item: CommandItem) => {
    const arg = findPickableArg(item)
    if (arg) openArgPicker(arg)
  }

  // The `/attachment` picker: same programmatic shape, plus a hand-off to the
  // host's file input for its "Upload a file…" entry.
  const onRequestFileUploadRef = useRef(onRequestFileUpload)
  onRequestFileUploadRef.current = onRequestFileUpload
  const requestAttachmentUpload = useCallback((anchorPos: number) => {
    pendingUploadInsertPosRef.current = anchorPos
    onRequestFileUploadRef.current?.()
  }, [])
  const {
    openAttachmentPicker: openPicker,
    renderAttachmentPicker,
    handleAttachmentPickerKeyDown,
  } = useAttachmentPicker(editorRef, {
    attachments: trayAttachments ?? NO_TRAY_ATTACHMENTS,
    onRequestUpload: canUploadFromPicker ? requestAttachmentUpload : undefined,
  })
  openAttachmentPickerRef.current = openPicker
  const attachmentPickerKeyDownRef = useRef(handleAttachmentPickerKeyDown)
  attachmentPickerKeyDownRef.current = handleAttachmentPickerKeyDown

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

  const handleFilesInsert = useCallback(
    (files: File[], editorInstance: ReturnType<typeof useEditor> | null): boolean => {
      const uploadFn = onFileUploadRef.current
      if (!uploadFn || !editorInstance || editorInstance.isDestroyed || files.length === 0) return false
      const uploadScopeVersion = uploadScopeVersionRef.current
      const batchId = `${Date.now()}_${Math.random().toString(36).slice(2)}`
      const insertions = files.map((file, index) => {
        const tempId = `temp_${batchId}_${index}`
        const attrs: AttachmentReferenceAttrs = {
          id: tempId,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          status: "uploading",
          imageIndex: null,
          error: null,
        }
        return { file, tempId, isImage: file.type.startsWith("image/"), attrs }
      })

      // A picked batch must reach the controlled editor as one document update;
      // intermediate renders can otherwise overwrite one placeholder while the
      // near-simultaneous reservations settle.
      if (!editorInstance.commands.insertAttachmentReferences(insertions.map(({ attrs }) => attrs))) return false

      for (const { file, tempId, isImage } of insertions) {
        void (async () => {
          const isStillTargeting = () =>
            uploadScopeVersion === uploadScopeVersionRef.current &&
            !editorInstance.isDestroyed &&
            editorRef.current === editorInstance

          try {
            const result = await uploadFn(file)
            if (!isStillTargeting()) return
            // uploadFn resolves once the id is RESERVED — the bytes may still be
            // streaming in the background. The node is a reference marker, so it
            // settles to "uploaded" here (live transfer state renders on the chip
            // row, and stored content never persists "uploading" — see
            // materializePendingAttachmentReferences).
            editorInstance.commands.updateAttachmentReference(tempId, {
              id: result.attachment.id,
              status: result.attachment.status === "error" ? "error" : "uploaded",
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
        })()
      }

      return true
    },
    []
  )

  const insertFiles = useCallback(
    (files: File[]): boolean => {
      const editorInstance = editorRef.current
      // A pick started from `/attachment` lands where the command was typed; the
      // native file dialog left the caret wherever focus went.
      const anchorPos = pendingUploadInsertPosRef.current
      pendingUploadInsertPosRef.current = null
      if (anchorPos !== null && editorInstance && !editorInstance.isDestroyed) {
        editorInstance
          .chain()
          .focus()
          .setTextSelection(Math.min(anchorPos, editorInstance.state.doc.content.size))
          .run()
      }
      return handleFilesInsert(files, editorInstance)
    },
    [handleFilesInsert]
  )

  const cancelPendingInlineUpload = useCallback(() => {
    pendingUploadInsertPosRef.current = null
  }, [])

  const removeAttachmentReferences = useCallback((attachmentId: string) => {
    const editorInstance = editorRef.current
    if (!editorInstance || editorInstance.isDestroyed) return
    editorInstance.commands.removeAttachmentReferences(attachmentId)
  }, [])

  // Save the snippet editor's contents as a text attachment, inserting the chip
  // back at the caret position the paste happened at. Reuses the same
  // upload-and-insert path as pasted images/files (handleFilesInsert), so E2E
  // encryption, scope-drift guarding, and the inline chip all come for free.
  const handleSnippetSave = useCallback(
    ({ text, filename }: { text: string; filename: string }) => {
      const editorInstance = editorRef.current
      const insertPos = snippetInsertPosRef.current
      setSnippetDraft(null)
      snippetInsertPosRef.current = null
      const uploadFn = onFileUploadRef.current
      if (!editorInstance || editorInstance.isDestroyed || !uploadFn) return

      const safeName = filename.trim() || SNIPPET_FALLBACK_FILENAME
      // Mime follows the final (possibly renamed) extension, not the original
      // sniff, so the filename stays the single source of truth.
      const file = new File([text], safeName, { type: snippetMimeForFilename(safeName) })

      // Restore the caret to where the paste landed (the dialog stole focus).
      const chain = editorInstance.chain().focus()
      if (insertPos != null) {
        const clamped = Math.min(insertPos, editorInstance.state.doc.content.size)
        chain.setTextSelection(clamped)
      }
      chain.run()

      handleFilesInsert([file], editorInstance)
    },
    [handleFilesInsert]
  )

  // Insert the chosen GIF as an inline embed rendered straight from Giphy's CDN
  // (no download/upload — that's how Giphy intends embeds to work). Synchronous,
  // so there's no scope-drift window to guard against.
  const handleGifSelect = useCallback((gif: GiphyGif) => {
    const editorInstance = editorRef.current
    if (!editorInstance || editorInstance.isDestroyed) return
    editorInstance
      .chain()
      .focus()
      .insertGiphyEmbed({ giphyUrl: gif.previewUrl, title: gif.title, width: gif.width, height: gif.height })
      .run()
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
    onFocus: () => {
      setIsFocused(true)
      // Through a ref: `useEditor` captures these options once, so calling the
      // prop directly would pin the first render's callback forever.
      onFocusRef.current?.()
    },
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
      clipboardTextSerializer: serializeClipboardSlice,
      handlePaste: (view, event) => {
        // Paste-without-formatting takes the clipboard's markdown down to the
        // text it stands for, so it must preempt the internal-paste shortcut
        // below (which would restore the styled document) and the chip/markdown
        // conversions further down. Snippet conversion still applies — that
        // guard is about size, not styling.
        const pasteAsPlainText = isPlainTextPaste(view)

        // Deliberately skips everything below, including snippet conversion:
        // an internal paste restores the exact document (chips included), and
        // converting a user's own composed content into a snippet would lose it.
        if (!pasteAsPlainText && isProseMirrorClipboardEvent(event)) {
          return false
        }

        const files = event.clipboardData?.files
        if (files && files.length > 0 && onFileUploadRef.current && editorRef.current) {
          event.preventDefault()
          let pasteImageOffset = 0
          const filesToInsert = Array.from(files).map((file) => {
            if (!file.type.startsWith("image/")) return file
            pasteImageOffset++
            const nextIndex = imageCountRef.current + pasteImageOffset
            const ext = file.name.split(".").pop() || "png"
            const newName = `pasted-image-${nextIndex}.${ext}`
            return new File([file], newName, { type: file.type })
          })
          handleFilesInsert(filesToInsert, editorRef.current)
          return true
        }

        // Parse pasted text through markdown parser to convert @mentions, #channels, :emoji:
        const text = event.clipboardData?.getData("text/plain")
        if (!text || !editorRef.current) {
          return false
        }

        if (!pasteAsPlainText && pasteLinkOverSelection(editorRef.current, text)) {
          event.preventDefault()
          return true
        }

        // A bare memo link pastes as an embed card rather than a plain URL.
        if (!pasteAsPlainText && enableMemoEmbed) {
          const memoId = parseMemoUrl(text.trim())
          if (memoId) {
            editorRef.current.commands.insertMemoEmbed({ memoId })
            event.preventDefault()
            return true
          }
        }

        // A bare in-app stream/message link pastes as an inline chip rather than
        // a raw URL, replacing the link text in the composer.
        if (!pasteAsPlainText && tryInsertInAppLinkChip(editorRef.current, text)) {
          event.preventDefault()
          return true
        }

        // Text too large to read inline becomes a snippet attachment: open the
        // editor seeded with the paste, remembering the caret so the chip lands
        // where the paste did. Needs an upload handler to attach through.
        if (onFileUploadRef.current && shouldConvertPasteToSnippet(text)) {
          event.preventDefault()
          snippetInsertPosRef.current = editorRef.current.state.selection.from
          snippetCountRef.current += 1
          const detected = detectSnippetFormat(text)
          setSnippetDraft({ text, filename: defaultSnippetFilename(snippetCountRef.current, detected.extension) })
          return true
        }

        const insert = pasteAsPlainText ? insertPlainText : insertPastedText
        const handled = insert(
          editorRef.current,
          text,
          enableMentions ? getMentionTypeRef.current : undefined,
          enableEmoji ? toEmojiRef.current : undefined,
          markdownParseOptionsRef.current
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

          const suggestionActive = isSuggestionActive(editor)
          if (handleBeforeInputNewline(editor, event as InputEvent, { allowDuringComposition: suggestionActive })) {
            return true
          }
          if (suggestionActive) return false

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

          // Gboard / SwiftKey clipboard-bar pastes can bypass the paste event.
          const inputEvent = event as InputEvent
          if (handleBeforeInputLinkPaste(editor, inputEvent)) {
            return true
          }
          if (
            inputEvent.inputType === "insertText" &&
            !editor.view.composing &&
            typeof inputEvent.data === "string" &&
            tryInsertInAppLinkChip(editor, inputEvent.data)
          ) {
            event.preventDefault()
            return true
          }

          // Gboard / SwiftKey clipboard-bar paste arrives as insertText, not paste.
          if (
            handleBeforeInputKeyboardPaste(
              editor,
              event as InputEvent,
              enableMentions ? getMentionTypeRef.current : undefined,
              enableEmoji ? toEmojiRef.current : undefined,
              markdownParseOptionsRef.current
            )
          ) {
            return true
          }

          return false
        },
      },
      handleDrop: (_view, event, _slice, moved) => {
        // Internal drag-and-drop (reordering) - let TipTap handle it
        if (moved) return false

        const files = event.dataTransfer?.files
        if (files && files.length > 0 && onFileUploadRef.current && editorRef.current) {
          event.preventDefault()
          handleFilesInsert(Array.from(files), editorRef.current)
          return true
        }
        return false
      },
      handleKeyDown: (_view, event) => {
        const currentEditor = editorRef.current

        // The command-argument picker preempts send / edit-last / blur while
        // open — same role TipTap's suggestion plugin plays for the @/slash
        // popups, but routed here since editorProps runs before the keymaps.
        if (argPickerKeyDownRef.current(event)) {
          return true
        }

        // The `/attachment` picker owns its keys for the same reason.
        if (attachmentPickerKeyDownRef.current(event)) {
          return true
        }

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
  onFocusRef.current = onFocusProp

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

    const stopExternalSync = getPerfCapture().time("editor.externalSync")

    const currentJson = JSON.stringify(editor.getJSON())
    const newJson = JSON.stringify(editableValue)
    if (newJson === currentJson) {
      externalSyncFailuresRef.current = 0
      stopExternalSync()
      return
    }

    const applied = applyExternalEditorContent(editor, editableValue, isInternalUpdate)
    stopExternalSync()
    if (applied) {
      externalSyncFailuresRef.current = 0
      return
    }

    // The source content is correct (it reached us as `value`); the editor just
    // failed to take it. Re-run next frame so the restored body still lands
    // instead of leaving a blank composer over a now-checked-out draft. Bounded
    // so a genuinely unparseable doc can't spin.
    if (externalSyncFailuresRef.current < 3) {
      externalSyncFailuresRef.current += 1
      const raf = requestAnimationFrame(() => setExternalSyncNonce((n) => n + 1))
      return () => cancelAnimationFrame(raf)
    }
  }, [editableValue, editor, externalSyncNonce])

  // A reference placed (drag or picker) while its upload was still reserving
  // carries the job's temp id. Flip it to the real id — and the image ordinal
  // send will use — the moment the tray learns it, the same flip the paste
  // upload path performs through its own callback. Without this the node keeps
  // an id no send path can resolve. Ordered AFTER the external-value sync
  // effect above: when a value change and a tray tick land in one commit, the
  // sync must apply the incoming doc first — flipping first would hand the
  // sync a doc that no longer matches `value`, and it would revert the flip.
  useEffect(() => {
    const editorInstance = editorRef.current
    if (!editorInstance || editorInstance.isDestroyed || !trayAttachments?.length) return
    const referenced = countAttachmentReferences(editorInstance.getJSON() as JSONContent)
    const tempIds = [...referenced.keys()].filter((id) => id.startsWith("temp_"))
    if (tempIds.length === 0) return
    const imageIndexes = buildImageIndexByAttachment(trayAttachments)
    for (const tempId of tempIds) {
      const attachmentId = findUploadJob(tempId)?.attachmentId
      if (!attachmentId) continue
      const attachment = trayAttachments.find((a) => a.id === attachmentId)
      editorInstance.commands.updateAttachmentReference(tempId, {
        id: attachmentId,
        imageIndex: attachment ? (imageIndexes.get(attachment) ?? null) : null,
      })
    }
  }, [trayAttachments])

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
        try {
          editor.commands.setContent(
            parseMarkdown(
              markdown,
              enableMentions ? getMentionType : undefined,
              enableEmoji ? toEmoji : undefined,
              markdownParseOptions
            )
          )
        } catch (err) {
          // Same guard as the external-value sync: a throw must not strand the
          // flag true, or every later onUpdate is swallowed and the composer
          // goes dead. The reparse is cosmetic, so dropping it leaves the
          // already-displayed content intact.
          console.error("Editor failed to reparse content for mention types", err)
        } finally {
          isInternalUpdate.current = false
        }
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

      // The suggestion plugins only activate at a word boundary — inserting a
      // bare trigger right after text appends a dead "@"/":"/"/" that opens
      // nothing. Prepend a space when the caret follows a non-whitespace char
      // (same rule as insertTranscribedText below).
      const { from } = selection
      const charBefore = from > 0 ? editor.state.doc.textBetween(from - 1, from) : ""
      const prefix = charBefore && !/\s/.test(charBefore) ? " " : ""
      editor.chain().focus().insertContent(`${prefix}${trigger}`).run()
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
    (text: string, options?: { joinPrevious?: boolean }) => {
      if (!editor || editor.isDestroyed || !text) return
      // Separate independent committed spans, but preserve a backend-declared
      // hard split when tracked insertion has to fall back to this plain path.
      const { from } = editor.state.selection
      const charBefore = from > 0 ? editor.state.doc.textBetween(from - 1, from) : ""
      const prefix = !options?.joinPrevious && charBefore && !/\s/.test(charBefore) ? " " : ""
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
    (args: { chunkId: string; contentJson: JSONContent; afterChunkId?: string; joinPrevious?: boolean }) => {
      if (!editor || editor.isDestroyed) return false
      return editor.chain().focus().insertDictationChunk(args).run()
    },
    [editor]
  )

  const replaceDictationChunk = useCallback(
    ({ chunkId, contentJson }: { chunkId: string; contentJson: JSONContent }) => {
      if (!editor || editor.isDestroyed) return false
      return editor.chain().replaceDictationChunk({ chunkId, contentJson }).run()
    },
    [editor]
  )

  const replaceDictationChunks = useCallback(
    (args: {
      sources: VoiceTranscriptReplacementSourceV4[]
      resultChunkId: string
      contentJson: JSONContent
    }): VoiceReplacementAckStatus => {
      if (!editor || editor.isDestroyed) return "missing"
      let status: VoiceReplacementAckStatus = "invalid"
      editor.commands.replaceDictationChunks({ ...args, onResult: (result) => (status = result) })
      return status
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

  const getDictationChunkContent = useCallback(
    (chunkId: string): JSONContent | null => {
      if (!editor || editor.isDestroyed) return null
      return getDictationChunkPositions(editor.state).find((c) => c.chunkId === chunkId)?.contentJson ?? null
    },
    [editor]
  )

  useImperativeHandle(
    ref,
    () => ({
      focus,
      focusAfterQuoteReply,
      insertMention: handleMentionClick,
      insertSlash: handleSlashClick,
      insertEmoji: handleEmojiClick,
      openSnippetEditor,
      insertFiles,
      cancelPendingInlineUpload,
      removeAttachmentReferences,
      insertTranscribedText,
      setDictationInterim,
      insertDictationChunk,
      replaceDictationChunk,
      replaceDictationChunks,
      lockDictationChunk,
      lockAllDictationChunks,
      getDictationChunkContent,
      getEditor: () => editor,
    }),
    [
      focus,
      focusAfterQuoteReply,
      handleMentionClick,
      handleSlashClick,
      handleEmojiClick,
      openSnippetEditor,
      insertFiles,
      cancelPendingInlineUpload,
      removeAttachmentReferences,
      insertTranscribedText,
      setDictationInterim,
      insertDictationChunk,
      replaceDictationChunk,
      replaceDictationChunks,
      lockDictationChunk,
      lockAllDictationChunks,
      getDictationChunkContent,
      editor,
    ]
  )

  return (
    <div ref={containerRef} className={cn("relative flex-1", disabled && "cursor-not-allowed opacity-50", className)}>
      <ComposerPillDndProvider editor={editor}>
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
        <ComposerPillCopyButton editor={editor} />
        {enableMentions ? renderMentionList() : null}
        {enableChannels ? renderChannelList() : null}
        {enableCommands ? renderCommandList() : null}
        {enableCommands ? renderArgPicker() : null}
        {enableCommands ? renderAttachmentPicker() : null}
        {enableEmoji ? renderEmojiGrid() : null}
        {enableMemoEmbed ? renderMemoList() : null}
        {giphyEnabled && workspaceId ? (
          <GiphyPickerDialog
            open={giphyOpen}
            onOpenChange={setGiphyOpen}
            workspaceId={workspaceId}
            onSelect={handleGifSelect}
          />
        ) : null}
        {onFileUpload ? (
          <SnippetEditorDialog
            open={snippetDraft !== null}
            onOpenChange={(open) => {
              if (!open) {
                setSnippetDraft(null)
                snippetInsertPosRef.current = null
              }
            }}
            initialText={snippetDraft?.text ?? ""}
            defaultFilename={snippetDraft?.filename ?? SNIPPET_FALLBACK_FILENAME}
            onSave={handleSnippetSave}
          />
        ) : null}
      </ComposerPillDndProvider>
    </div>
  )
})
