import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useMemo,
  useCallback,
  useRef,
  useState,
  useEffect,
  useId,
} from "react"
import { ArrowUp, X, Plus, AtSign, Slash, Paperclip, Maximize2 } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePreferencesOptional } from "@/contexts"
import { getEffectiveKeyBinding, matchesKeyBinding } from "@/lib/keyboard-shortcuts"
import { RichEditor, EditorToolbar, EditorActionBar } from "@/components/editor"
import type { RichEditorHandle } from "@/components/editor"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { PendingAttachments } from "@/components/timeline/pending-attachments"
import { MicButton } from "./mic-button"
import { ContextRefStrip } from "./context-ref-strip"
import type { DraftContextRef } from "@/lib/context-bag/types"
import { cn } from "@/lib/utils"
import type { PendingAttachment, UploadResult } from "@/hooks/use-attachments"
import type { MessageSendMode, JSONContent } from "@threa/types"
import type { MentionStreamContext } from "@/hooks/use-mentionables"
import type { Editor } from "@tiptap/react"

/** Check whether the document has content beyond a single line. */
function isMultiLine(doc: JSONContent): boolean {
  const blocks = doc.content
  if (!blocks?.length) return false

  // Filter out empty trailing paragraphs (TipTap always appends one)
  const nonEmpty = blocks.filter((b) => b.type !== "paragraph" || (b.content?.length ?? 0) > 0)
  if (nonEmpty.length > 1) return true

  const first = nonEmpty[0]
  if (!first) return false

  if ((first.type === "bulletList" || first.type === "orderedList") && (first.content?.length ?? 0) > 1) return true
  if (first.type === "codeBlock") {
    const text = (first.content ?? []).map((c) => c.text ?? "").join("")
    return text.includes("\n")
  }
  if (first.content?.some((c) => c.type === "hardBreak")) return true

  return false
}

/** Extract the first line of plain text from editor content for the mobile preview bar. */
function getPreviewText(doc: JSONContent): string {
  function walk(node: JSONContent): string | null {
    if (node.type === "text") return node.text ?? ""
    if (node.type === "mention") return `@${node.attrs?.label ?? ""}`
    if (node.type === "emoji") return String(node.attrs?.emoji ?? node.attrs?.shortcode ?? "")
    if (node.type === "hardBreak") return null

    if (node.type === "quoteReply") {
      const author = typeof node.attrs?.authorName === "string" ? node.attrs.authorName : ""
      return `Replying to ${author}`
    }

    if (node.type === "sharedMessage") {
      const author = typeof node.attrs?.authorName === "string" ? node.attrs.authorName : ""
      return author ? `Sharing message from ${author}` : "Sharing a message"
    }

    if (node.type === "codeBlock") {
      const text = (node.content ?? []).map((c) => c.text ?? "").join("")
      return text.split("\n")[0] ?? ""
    }

    if (!node.content?.length) return null

    if (node.type === "paragraph" || node.type === "heading") {
      const parts: string[] = []
      for (const child of node.content) {
        const t = walk(child)
        if (t === null) break
        parts.push(t)
      }
      return parts.join("") || null
    }

    for (const child of node.content) {
      const t = walk(child)
      if (t) return t
    }
    return null
  }

  const firstLine = walk(doc)?.trim() ?? ""
  if (!firstLine) return ""
  return isMultiLine(doc) ? `${firstLine}…` : firstLine
}

/** Platform-appropriate modifier key symbol (⌘ on Mac, Ctrl+ elsewhere) */
const MOD_SYMBOL = navigator.platform?.toLowerCase().includes("mac") ? "⌘" : "Ctrl+"
const MOD_KEY_NAME = navigator.platform?.toLowerCase().includes("mac") ? "Command" : "Control"

export interface ComposerControlHandle {
  focus(): void
  focusAfterQuoteReply(): void
  getEditor(): Editor | null
}

export interface MessageComposerProps {
  // Content (controlled)
  content: JSONContent
  onContentChange: (content: JSONContent) => void

  // Attachments (controlled)
  pendingAttachments: PendingAttachment[]
  onRemoveAttachment: (id: string) => void
  /**
   * Context refs attached to the current draft (sidecar). Rendered inline
   * with `pendingAttachments` as one unified attachment row using the same
   * `<AttachmentPill>` primitive — matches the user mental model that both
   * are "things attached to this message" and preps for an eventual
   * unified bag where attachments live as another ref kind.
   */
  contextRefs?: DraftContextRef[]
  /** Stream id; required only when `contextRefs` is non-empty so the strip can build deep-links. */
  streamId?: string
  /** Workspace id; required only when `contextRefs` is non-empty so the strip can fetch source metadata. */
  workspaceId?: string
  fileInputRef: RefObject<HTMLInputElement | null>
  onFileSelect: (e: ChangeEvent<HTMLInputElement>) => void
  /** Called when files are pasted or dropped into the editor */
  onFileUpload?: (file: File) => Promise<UploadResult>
  /** Current count of images for sequential naming of pasted images */
  imageCount?: number

  // Submit
  onSubmit: (content?: JSONContent) => void
  canSubmit: boolean
  submitLabel?: string
  submittingLabel?: string

  // State
  isSubmitting?: boolean
  hasFailed?: boolean

  // Customization
  placeholder?: string
  disabled?: boolean
  className?: string

  /** How Enter key behaves: "enter" = Enter sends, "cmdEnter" = Cmd+Enter sends */
  messageSendMode?: MessageSendMode

  /** Auto-focus the editor when mounted */
  autoFocus?: boolean

  /** Scope identifier — when it changes, re-focus the editor (if autoFocus) */
  scopeId?: string

  /** Called when ArrowUp is pressed in an empty editor — triggers edit-last-message */
  onEditLastMessage?: () => void

  /** Called when the desktop expand button is clicked — opens fullscreen document editor */
  onExpandClick?: () => void

  /** When true, the composer fills its container with full-height editor and always-visible toolbar */
  expanded?: boolean
  /** Called to collapse the expanded editor back to inline mode */
  onCollapse?: () => void
  /** Stream context for filtering which broadcast mentions (@channel, @here) are available */
  streamContext?: MentionStreamContext
  /** Imperative handle ref for programmatic focus from parent */
  composerRef?: React.MutableRefObject<ComposerControlHandle | null>

  /**
   * Triggered when the user presses Cmd/Ctrl+S with focus inside the composer,
   * or when they click "Save current" in the stashed-drafts picker. The host
   * is responsible for snapshotting the current content/attachments, adding a
   * row to the stash, clearing the active draft, and showing a toast. An
   * empty composer should no-op; the picker disables its own button when
   * `canStashCurrent` is false.
   */
  onStashDraft?: () => void

  /**
   * Slot for the stashed-drafts picker trigger used in the desktop inline
   * toolbar and the mobile action bar (compact size). Omit to hide the
   * affordance entirely (used by edit forms and other non-draft consumers).
   */
  stashedDraftsTrigger?: ReactNode

  /**
   * Separate slot for the expanded-mode FAB drawer, where the trigger needs
   * to match the 30x30 outline-shadow style of the other drawer buttons.
   * Hosts pass both slots because the picker is rendered fresh in each
   * context rather than shared by reference.
   */
  stashedDraftsTriggerFab?: ReactNode

  /**
   * Slot for the unified scheduled-messages picker — both the "schedule this
   * draft" entry point and the "what's queued for this stream?" peek live
   * behind a single trigger. Omit to hide the affordance entirely (used by
   * edit forms and any composer that isn't sending a fresh message).
   */
  scheduledMessagesTrigger?: ReactNode

  /**
   * Separate slot for the expanded-mode FAB drawer; mirrors
   * `stashedDraftsTriggerFab`. The picker is rendered fresh per context
   * (with `size="fab"`) rather than shared by reference because the trigger
   * sizing differs between the inline action bar and the floating drawer.
   */
  scheduledMessagesTriggerFab?: ReactNode
}

export function MessageComposer({
  content,
  onContentChange,
  pendingAttachments,
  onRemoveAttachment,
  contextRefs,
  streamId,
  workspaceId,
  fileInputRef,
  onFileSelect,
  onFileUpload,
  imageCount = 0,
  onSubmit,
  canSubmit,
  submitLabel = "Send",
  submittingLabel = "Sending...",
  isSubmitting = false,
  hasFailed = false,
  placeholder = "Type a message...",
  disabled = false,
  className,
  messageSendMode = "enter",
  autoFocus = false,
  scopeId,
  onEditLastMessage,
  onExpandClick,
  expanded = false,
  onCollapse,
  streamContext,
  composerRef,
  onStashDraft,
  stashedDraftsTrigger,
  stashedDraftsTriggerFab,
  scheduledMessagesTrigger,
  scheduledMessagesTriggerFab,
}: MessageComposerProps) {
  // Controls (buttons, file input) are disabled during both external disable and sending.
  // The editor itself stays editable during sending so mobile keyboards don't close/reopen.
  const controlsDisabled = disabled || isSubmitting

  const richEditorRef = useRef<RichEditorHandle>(null)
  const expandedShellRef = useRef<HTMLDivElement>(null)
  const actionBarWrapperRef = useRef<HTMLDivElement>(null)
  const [mobileToolbarEditor, setMobileToolbarEditor] = useState<Editor | null>(null)
  const [formatOpen, setFormatOpen] = useState(false)
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const [mobileFocused, setMobileFocused] = useState(false)
  const [mobileLinkPopoverOpen, setMobileLinkPopoverOpen] = useState(false)
  // True while a dictation take is in flight. Keeps the mobile chrome (and the
  // mic button it lives in) mounted across a tap-outside blur so the session
  // isn't torn down mid-take.
  const [voiceActive, setVoiceActive] = useState(false)
  const isMobile = useIsMobile()
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const instructionsId = useId()

  // Close inline format toolbar and collapse expansion when navigating to a different stream/scope.
  // Clearing voiceActive collapses the mobile chrome; combined with the scopeId-keyed mic below,
  // an in-flight dictation take ends on navigation rather than carrying over into the next stream.
  useEffect(() => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current)
      blurTimeoutRef.current = null
    }
    setFormatOpen(false)
    setMobileExpanded(false)
    setMobileFocused(false)
    setMobileLinkPopoverOpen(false)
    setVoiceActive(false)
  }, [scopeId])

  // Reset mobile-only state when viewport crosses the mobile/desktop threshold
  useEffect(() => {
    if (!isMobile) {
      setMobileExpanded(false)
      setMobileFocused(false)
      setMobileLinkPopoverOpen(false)
    }
  }, [isMobile])

  // Mobile chrome (action bar + full editor padding) stays open while focused
  // OR while a dictation take is in flight, so a tap-outside doesn't unmount the
  // mic mid-take and abort the session.
  const mobileChromeOpen = mobileFocused || voiceActive

  // Track focus state for mobile progressive disclosure.
  // Uses a small delay on blur to avoid flicker when focus moves between editor and action bar buttons.
  const handleFocusCapture = useCallback(() => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current)
      blurTimeoutRef.current = null
    }
    setMobileFocused(true)
  }, [])

  const handleBlurCapture = useCallback(() => {
    blurTimeoutRef.current = setTimeout(() => {
      setMobileFocused(false)
      setMobileExpanded(false)
      setFormatOpen(false)
      setMobileLinkPopoverOpen(false)
    }, 150)
  }, [])

  // Cleanup timeout on unmount
  useEffect(
    () => () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    },
    []
  )

  // Build the send mode hint text (reactive to preference changes).
  // Expanded (fullscreen) and mobile always use cmdEnter — on mobile the send button
  // is the only way to send, so Enter just inserts a newline.
  const effectiveSendMode = expanded || isMobile ? "cmdEnter" : messageSendMode
  const sendHint = useMemo(() => {
    if (effectiveSendMode === "enter") {
      return `Enter to send · Shift+Enter for new line`
    }
    return `${MOD_SYMBOL}Enter to send`
  }, [effectiveSendMode])

  const screenReaderInstructions = useMemo(() => {
    const sendInstructions =
      effectiveSendMode === "enter"
        ? "Press Enter to send and Shift+Enter for a new line."
        : `Press ${MOD_KEY_NAME}+Enter to send.`

    if (expanded) {
      return `${sendInstructions} Tab and Shift+Tab indent content. Press Escape to leave the editor. Press Escape again to close the fullscreen editor.`
    }

    return `${sendInstructions} Tab and Shift+Tab indent content. Press Escape to leave the editor.`
  }, [effectiveSendMode, expanded])

  // Plain-text first line for the mobile collapsed preview bar
  const previewText = useMemo(() => getPreviewText(content), [content])

  // Handle attach button click
  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [fileInputRef])

  const handleSubmit = useCallback(() => {
    setFormatOpen(false)
    setMobileExpanded(false)
    setMobileLinkPopoverOpen(false)
    onSubmit(richEditorRef.current?.getEditor()?.getJSON() as JSONContent | undefined)
  }, [onSubmit])

  // Stable ref so TipTap's captured closure always invokes the current handler
  // without needing to re-register on every render.
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange

  const handleContentChange = useCallback((newContent: JSONContent) => {
    onContentChangeRef.current(newContent)
  }, [])

  const setRichEditorHandle = useCallback((handle: RichEditorHandle | null) => {
    richEditorRef.current = handle
    const nextEditor = handle?.getEditor() ?? null
    setMobileToolbarEditor((currentEditor) => (currentEditor === nextEditor ? currentEditor : nextEditor))
  }, [])

  // Expose focus() to parent via composerRef so external triggers (e.g. quote reply)
  // can open the mobile editor and focus it programmatically.
  useEffect(() => {
    if (!composerRef) return
    composerRef.current = {
      focus: () => {
        setMobileFocused(true)
        requestAnimationFrame(() => richEditorRef.current?.focus())
      },
      focusAfterQuoteReply: () => {
        setMobileFocused(true)
        requestAnimationFrame(() => richEditorRef.current?.focusAfterQuoteReply())
      },
      getEditor: () => richEditorRef.current?.getEditor() ?? null,
    }
    return () => {
      composerRef.current = null
    }
  }, [composerRef])

  const focusExpandedShell = useCallback(() => {
    expandedShellRef.current?.focus()
  }, [])

  const handleExpandedShellKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") return
      if (event.target !== event.currentTarget) return
      if (!onCollapse) return

      event.preventDefault()
      onCollapse()
    },
    [onCollapse]
  )

  // `draftStash` stashes the current draft. Attached in the capture phase on
  // the composer root so it runs before TipTap's contentEditable sees the
  // event, and before the browser's default "save page" behavior. Capture
  // scopes the shortcut to whichever composer actually received focus — if
  // main + thread are both mounted, only the focused one fires. Registered
  // via `SHORTCUT_ACTIONS`, so the user can remap it in settings.
  const preferencesCtx = usePreferencesOptional()
  const stashBinding = getEffectiveKeyBinding("draftStash", preferencesCtx?.preferences?.keyboardShortcuts ?? {})

  const handleStashKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!stashBinding) return
      if (!matchesKeyBinding(event.nativeEvent, stashBinding)) return

      event.preventDefault()
      event.stopPropagation()
      onStashDraft?.()
    },
    [onStashDraft, stashBinding]
  )

  const sharedEditor = (
    <RichEditor
      ref={setRichEditorHandle}
      value={content}
      onChange={handleContentChange}
      onSubmit={handleSubmit}
      onFileUpload={onFileUpload}
      imageCount={imageCount}
      placeholder={placeholder}
      disabled={disabled}
      messageSendMode={effectiveSendMode}
      autoFocus={autoFocus}
      scopeId={scopeId}
      staticToolbarOpen={!isMobile && formatOpen}
      disableSelectionToolbar={isMobile}
      onEditLastMessage={onEditLastMessage}
      ariaLabel="Message input"
      ariaDescribedBy={instructionsId}
      blurOnEscape
      streamContext={streamContext}
    />
  )

  // ── Send button (shared between states) ──────────────────────────────
  const sendButton = hasFailed ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            disabled
            className="h-[30px] w-[30px] shrink-0 p-0 pointer-events-none rounded-md"
            aria-label={submitLabel}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>Remove failed uploads before sending</p>
      </TooltipContent>
    </Tooltip>
  ) : (
    <Button
      type="button"
      onClick={handleSubmit}
      disabled={!canSubmit}
      aria-label={isSubmitting ? submittingLabel : submitLabel}
      className="h-[30px] w-[30px] shrink-0 p-0 rounded-md"
    >
      <ArrowUp className="h-4 w-4" />
    </Button>
  )

  // ── Mic / dictation button ────────────────────────────────────────────────
  // Always available on workspace surfaces so dictation can be resumed after the
  // composer already has text — appended at the caret like committed speech.
  const insertTranscribedText = useCallback((text: string) => richEditorRef.current?.insertTranscribedText(text), [])
  const setDictationInterim = useCallback((text: string) => richEditorRef.current?.setDictationInterim(text), [])
  // Keyed by scopeId so navigating to a different stream remounts the button, tearing down any
  // in-flight dictation session (the unmount cleanup aborts the take) instead of carrying it over.
  const micButton = workspaceId ? (
    <MicButton
      key={`mic-${scopeId ?? ""}`}
      workspaceId={workspaceId}
      onInsertText={insertTranscribedText}
      onInterimText={setDictationInterim}
      onActiveChange={setVoiceActive}
      disabled={controlsDisabled}
    />
  ) : null
  const micButtonFab = workspaceId ? (
    <MicButton
      key={`mic-fab-${scopeId ?? ""}`}
      workspaceId={workspaceId}
      onInsertText={insertTranscribedText}
      onInterimText={setDictationInterim}
      onActiveChange={setVoiceActive}
      disabled={controlsDisabled}
      className="h-[30px] w-[30px] rounded-md border bg-background shadow-md"
    />
  ) : null

  // ── Expanded (fullscreen) layout ──────────────────────────────────────────
  // Trailing content for the inline toolbar: just the close X
  const expandedTrailingContent = expanded ? (
    <div className="flex items-center gap-0.5 shrink-0 ml-auto">
      <Separator orientation="vertical" className="mx-1 h-6" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close editor"
            className="h-8 w-8 p-0 hover:bg-muted"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onCollapse?.()}
          >
            <X className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Close (Esc)
        </TooltipContent>
      </Tooltip>
    </div>
  ) : undefined

  if (expanded) {
    return (
      <TooltipProvider delayDuration={300}>
        <div
          ref={expandedShellRef}
          className={cn("relative flex flex-col h-full bg-background", className)}
          tabIndex={-1}
          onKeyDown={handleExpandedShellKeyDown}
          onKeyDownCapture={handleStashKeyDown}
        >
          <p id={instructionsId} className="sr-only">
            {screenReaderInstructions}
          </p>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onFileSelect}
            disabled={controlsDisabled}
          />

          {/* Editor — fills remaining space, toolbar + actions in one bar via toolbarTrailingContent */}
          <div
            className="flex-1 min-h-0 overflow-y-auto px-4 [&_.tiptap]:max-h-none [&_.tiptap]:min-h-[200px]"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button,a,input,textarea,[contenteditable],[role='button']")) return
              richEditorRef.current?.focus()
            }}
          >
            <RichEditor
              ref={setRichEditorHandle}
              value={content}
              onChange={handleContentChange}
              onSubmit={handleSubmit}
              onFileUpload={onFileUpload}
              imageCount={imageCount}
              placeholder={placeholder}
              disabled={disabled}
              messageSendMode="cmdEnter"
              autoFocus
              scopeId={scopeId}
              staticToolbarOpen
              disableSelectionToolbar
              onEditLastMessage={onEditLastMessage}
              toolbarTrailingContent={expandedTrailingContent}
              ariaLabel="Fullscreen message editor"
              ariaDescribedBy={instructionsId}
              blurOnEscape
              onEscapeBlur={focusExpandedShell}
              streamContext={streamContext}
              belowToolbarContent={
                pendingAttachments.length > 0 || (contextRefs && contextRefs.length > 0) ? (
                  <div className="pt-1 pb-2 border-b border-border/50 [&>div]:mb-0">
                    <PendingAttachments
                      attachments={pendingAttachments}
                      onRemove={onRemoveAttachment}
                      beforePills={
                        contextRefs && contextRefs.length > 0 && streamId && workspaceId ? (
                          <ContextRefStrip workspaceId={workspaceId} streamId={streamId} draftRefs={contextRefs} />
                        ) : null
                      }
                    />
                  </div>
                ) : undefined
              }
            />
            {/* Extra space so the writing position can be centered on screen */}
            <div className="h-[50vh]" />
          </div>

          {/* Floating action drawer + send button — bottom-right corner */}
          <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 group/fab">
            {/* Action drawer — slides out from behind the + button on hover or focus-within */}
            <div className="flex items-center gap-1 overflow-hidden max-w-0 opacity-0 group-hover/fab:max-w-[240px] group-hover/fab:opacity-100 group-focus-within/fab:max-w-[240px] group-focus-within/fab:opacity-100 transition-all duration-200 ease-out">
              {stashedDraftsTriggerFab}
              {scheduledMessagesTriggerFab}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Insert emoji"
                    className="h-[30px] w-[30px] shrink-0 p-0 rounded-md bg-background shadow-md"
                    onPointerDown={(e) => {
                      e.preventDefault()
                      richEditorRef.current?.insertEmoji()
                    }}
                    disabled={controlsDisabled}
                  >
                    <span className="text-sm leading-none">😊</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Emoji
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Insert mention"
                    className="h-[30px] w-[30px] shrink-0 p-0 rounded-md bg-background shadow-md"
                    onPointerDown={(e) => {
                      e.preventDefault()
                      richEditorRef.current?.insertMention()
                    }}
                    disabled={controlsDisabled}
                  >
                    <AtSign className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Mention
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Insert command"
                    className="h-[30px] w-[30px] shrink-0 p-0 rounded-md bg-background shadow-md"
                    onPointerDown={(e) => {
                      e.preventDefault()
                      richEditorRef.current?.insertSlash()
                    }}
                    disabled={controlsDisabled}
                  >
                    <Slash className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Command
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Attach files"
                    className="h-[30px] w-[30px] shrink-0 p-0 rounded-md bg-background shadow-md"
                    onClick={handleAttachClick}
                    disabled={controlsDisabled}
                  >
                    <Paperclip className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Attach files
                </TooltipContent>
              </Tooltip>
            </div>
            {/* Plus button — triggers drawer reveal */}
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Actions"
              className="h-[30px] w-[30px] shrink-0 p-0 rounded-md bg-background shadow-md group-hover/fab:[&_svg]:rotate-45 group-focus-within/fab:[&_svg]:rotate-45 [&_svg]:transition-transform"
              tabIndex={-1}
            >
              <Plus className="h-4 w-4" />
            </Button>
            {micButtonFab}
            {/* Send button */}
            {hasFailed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      disabled
                      className="h-[30px] w-[30px] shrink-0 p-0 pointer-events-none rounded-md shadow-md"
                      aria-label={submitLabel}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Remove failed uploads before sending</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    aria-label={isSubmitting ? submittingLabel : submitLabel}
                    className="h-[30px] w-[30px] shrink-0 p-0 rounded-md shadow-md"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">
                  {sendHint}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </TooltipProvider>
    )
  }

  // ── Inline layout ────────────────────────────────────────────────────────
  return (
    <TooltipProvider delayDuration={300}>
      {/* Message input wrapper — dvh units respect the virtual keyboard on mobile */}
      <div
        className={cn(
          "flex flex-col transition-[max-height,min-height] duration-200 ease-out",
          mobileExpanded ? "max-h-[75dvh] min-h-[75dvh]" : "max-h-[380px] min-h-0",
          className
        )}
        onFocusCapture={isMobile ? handleFocusCapture : undefined}
        onBlurCapture={isMobile ? handleBlurCapture : undefined}
        onKeyDownCapture={handleStashKeyDown}
      >
        <p id={instructionsId} className="sr-only">
          {screenReaderInstructions}
        </p>
        {/* Attachment bar - shown above input */}
        <PendingAttachments
          attachments={pendingAttachments}
          onRemove={onRemoveAttachment}
          beforePills={
            contextRefs && contextRefs.length > 0 && streamId && workspaceId ? (
              <ContextRefStrip workspaceId={workspaceId} streamId={streamId} draftRefs={contextRefs} />
            ) : null
          }
        />

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onFileSelect}
          disabled={controlsDisabled}
        />

        {/* Main input area */}
        <div className="input-glow-wrapper flex-1 flex flex-col min-h-0">
          <div
            className={cn(
              "rounded-[16px] border border-input bg-card flex flex-col flex-1 min-h-0",
              // Compact padding when mobile-unfocused (single line), normal otherwise
              isMobile && !mobileChromeOpen ? "px-3 py-2" : "p-3 gap-2",
              // When mobile-expanded, let the editor grow and override its internal max-height
              mobileExpanded && "[&_.tiptap]:max-h-none"
            )}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button,a,input,textarea,[contenteditable],[role='button']")) return
              // On mobile unfocused, reveal the editor first then focus on next frame
              if (isMobile && !mobileChromeOpen) {
                setMobileFocused(true)
                requestAnimationFrame(() => richEditorRef.current?.focus())
                return
              }
              richEditorRef.current?.focus()
            }}
          >
            {/* Mobile preview bar — plain text first line + send button */}
            {isMobile && !mobileChromeOpen && (
              <div className="flex items-center gap-2 min-h-[30px] text-sm select-none pointer-events-none">
                <span className="flex-1 min-w-0 truncate text-muted-foreground">{previewText || placeholder}</span>
                <div className="pointer-events-auto">{sendButton}</div>
              </div>
            )}

            {/* Editor — always mounted to preserve state; hidden in preview mode */}
            <div
              className={cn(
                isMobile && !mobileChromeOpen ? "h-0 overflow-hidden" : "flex-1 min-h-0",
                mobileExpanded && "overflow-y-auto"
              )}
            >
              <div className="h-full">{sharedEditor}</div>
            </div>

            {/* Bottom action bar — visible on desktop always, on mobile when focused or dictating.
               onMouseDown preventDefault keeps editor focus on mobile so the virtual keyboard
               stays open when tapping any button in this bar.

               Subtlety: React synthetic events bubble through the *React component
               tree*, not the DOM tree. Slots like `scheduledMessagesTrigger` host
               Radix Popover/Dialog whose content is portaled into <body>, but
               their synthetic events still bubble back here through the React
               tree. A blanket `preventDefault` therefore cancels native focus on
               inputs (date/time pickers, search inputs) inside those portals. The
               DOM-subtree guard below limits the suppression to elements actually
               living under this wrapper — buttons in our own action bar — and
               leaves portaled content untouched. */}
            {(!isMobile || mobileChromeOpen) && (
              <div
                ref={actionBarWrapperRef}
                onMouseDown={(e) => {
                  if (!actionBarWrapperRef.current?.contains(e.target as Node)) return
                  e.preventDefault()
                }}
              >
                {isMobile ? (
                  <EditorActionBar
                    editorHandle={richEditorRef.current}
                    disabled={controlsDisabled}
                    formatOpen={formatOpen}
                    onFormatOpenChange={setFormatOpen}
                    mobileExpanded={mobileExpanded}
                    onMobileExpandedChange={setMobileExpanded}
                    showAttach
                    onAttachClick={handleAttachClick}
                    trailingContent={
                      micButton || stashedDraftsTrigger || scheduledMessagesTrigger ? (
                        <div className="flex items-center gap-1">
                          {micButton}
                          {stashedDraftsTrigger}
                          {scheduledMessagesTrigger}
                          {sendButton}
                        </div>
                      ) : (
                        sendButton
                      )
                    }
                  />
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] text-muted-foreground flex-1 select-none pointer-events-none">
                      Select text to format
                    </span>
                    {onExpandClick && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Expand to fullscreen editor"
                            className="h-7 w-7 shrink-0"
                            onClick={onExpandClick}
                            disabled={controlsDisabled}
                          >
                            <Maximize2 className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          Expand editor
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Formatting"
                          aria-pressed={formatOpen}
                          className={cn("h-7 w-7 shrink-0", formatOpen && "bg-accent text-accent-foreground")}
                          onClick={() => setFormatOpen((v) => !v)}
                          disabled={controlsDisabled}
                        >
                          <span className="text-[13px] font-bold leading-none tracking-tight">Aa</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        Formatting
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Insert emoji"
                          className="h-7 w-7 shrink-0"
                          onClick={() => richEditorRef.current?.insertEmoji()}
                          disabled={controlsDisabled}
                        >
                          <span className="text-sm leading-none">😊</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        Emoji
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Insert mention"
                          className="h-7 w-7 shrink-0"
                          onClick={() => richEditorRef.current?.insertMention()}
                          disabled={controlsDisabled}
                        >
                          <AtSign className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        Mention
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Insert command"
                          className="h-7 w-7 shrink-0 hidden sm:inline-flex"
                          onClick={() => richEditorRef.current?.insertSlash()}
                          disabled={controlsDisabled}
                        >
                          <Slash className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        Command
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Attach files"
                          className="h-7 w-7 shrink-0"
                          onClick={handleAttachClick}
                          disabled={controlsDisabled}
                        >
                          <Paperclip className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        Attach files
                      </TooltipContent>
                    </Tooltip>
                    {micButton}
                    {stashedDraftsTrigger}
                    {scheduledMessagesTrigger}
                    {sendButton}
                  </div>
                )}
              </div>
            )}

            {/* Mobile formatting toolbar — rendered below action bar, above keyboard */}
            {isMobile && formatOpen && (
              <EditorToolbar
                editor={mobileToolbarEditor}
                isVisible
                inline
                inlinePosition="below"
                linkPopoverOpen={mobileLinkPopoverOpen}
                onLinkPopoverOpenChange={setMobileLinkPopoverOpen}
                showSpecialInputControls
              />
            )}
          </div>
        </div>

        {/* Send hint */}
        <div className="flex justify-end px-1 pt-1">
          <span className="text-[10px] text-muted-foreground opacity-60 hidden sm:block select-none pointer-events-none">
            {sendHint}
          </span>
        </div>
      </div>
    </TooltipProvider>
  )
}
