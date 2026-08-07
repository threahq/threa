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
import { flushSync } from "react-dom"
import { ArrowUp, X, Plus, AtSign, Slash, Paperclip } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"
import { useInputMode } from "@/hooks/use-input-mode"
import { useComposerActionSide } from "@/hooks/use-composer-action-side"
import { usePreferencesOptional } from "@/contexts"
import { getEffectiveKeyBinding, matchesKeyBinding } from "@/lib/keyboard-shortcuts"
import { RichEditor, EditorToolbar, EditorActionBar } from "@/components/editor"
import type { RichEditorHandle } from "@/components/editor"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { PendingAttachments } from "@/components/timeline/pending-attachments"
import { MicButton, type MicButtonHandle } from "./mic-button"
import { FabDrawerCloseContext } from "./fab-drawer-close-context"
import { StashedDraftsComposerBridgeContext, type StashedDraftsComposerBridge } from "./stashed-drafts-open-context"
import { ComposerActionBar } from "./composer-action-bar"
import { ComposerLinkPreviews } from "./composer-link-previews"
import { ContextRefStrip } from "./context-ref-strip"
import type { DraftContextRef } from "@/lib/context-bag/types"
import { cn } from "@/lib/utils"
import { COLLAPSED_COMPOSER_ROW, COLLAPSED_COMPOSER_SHADOW } from "@/components/composer/collapsed-composer-bar"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { collapsedComposerPreview } from "@/lib/drafts/collapsed-composer-preview"
import type { PendingAttachment, UploadResult } from "@/hooks/use-attachments"
import type { MessageSendMode, JSONContent } from "@threa/types"
import type { MentionStreamContext } from "@/hooks/use-mentionables"
import type { Editor } from "@tiptap/react"
import { consumeComposerCommandRequest, subscribeComposerCommandRequest } from "@/stores/composer-command-request-store"

function prependComposerCommand(content: JSONContent, command: string): JSONContent {
  const first = content.content?.[0]
  if (first?.type === "paragraph") {
    const firstInline = first.content?.[0]
    const commandName = command.trim()
    const alreadyPrefixed =
      (typeof firstInline?.text === "string" &&
        (firstInline.text === commandName || firstInline.text.startsWith(`${commandName} `))) ||
      (firstInline?.type === "slashCommand" && firstInline.attrs?.name === commandName.slice(1))
    if (alreadyPrefixed) return content
    return {
      ...content,
      content: [
        { ...first, content: [{ type: "text", text: command }, ...(first.content ?? [])] },
        ...(content.content ?? []).slice(1),
      ],
    }
  }
  return {
    ...content,
    content: [{ type: "paragraph", content: [{ type: "text", text: command }] }, ...(content.content ?? [])],
  }
}

/** Platform-appropriate modifier key symbol (⌘ on Mac, Ctrl+ elsewhere) */
const MOD_SYMBOL = navigator.platform?.toLowerCase().includes("mac") ? "⌘" : "Ctrl+"
const MOD_KEY_NAME = navigator.platform?.toLowerCase().includes("mac") ? "Command" : "Control"

/**
 * How long to wait for the keyboard's viewport resize after an editor focus
 * before expanding the mobile chrome anyway. Covers hardware keyboards and
 * browsers that never resize the viewport; the soft-keyboard resize lands
 * well inside this on both Chrome and Firefox Android.
 */
const KEYBOARD_RESIZE_WAIT_MS = 300

export interface ComposerControlHandle {
  focus(): void
  focusAfterQuoteReply(): void
  getEditor(): Editor | null
  /** Open the snippet editor in this composer (e.g. from the command palette). */
  openSnippetEditor(): void
}

export interface MessageComposerProps {
  content: JSONContent
  onContentChange: (content: JSONContent) => void

  pendingAttachments: PendingAttachment[]
  onRemoveAttachment: (id: string) => void
  /** Abort an in-flight upload and drop its chip (the × during upload). */
  onCancelAttachmentUpload?: (id: string) => void
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
  /**
   * Access anchor for the `/memo` picker. Defaults to `streamId`; pass it
   * explicitly when the composer has no real `streamId` yet (e.g. a draft thread
   * anchors to its parent stream). May be a thread or root — the backend resolves
   * the root.
   */
  memoAnchorStreamId?: string
  /**
   * Scopes the `/` command palette to this composer's stream instead of the
   * route's. Conversation surfaces (board card / panel) pass their own stream —
   * `null` when it isn't resolved yet, which is still a scoping claim: the route
   * must not stand in for it.
   */
  commandStreamId?: string | null
  /** Workspace id; required only when `contextRefs` is non-empty so the strip can fetch source metadata. */
  workspaceId?: string
  fileInputRef: RefObject<HTMLInputElement | null>
  onFileSelect: (e: ChangeEvent<HTMLInputElement>) => void
  /** Called when files are pasted or dropped into the editor */
  onFileUpload?: (file: File) => Promise<UploadResult>
  /** Current count of images for sequential naming of pasted images */
  imageCount?: number

  onSubmit: (content?: JSONContent) => void
  canSubmit: boolean
  submitLabel?: string
  submittingLabel?: string

  isSubmitting?: boolean
  hasFailed?: boolean

  placeholder?: string
  disabled?: boolean
  className?: string

  /** How Enter key behaves: "enter" = Enter sends, "cmdEnter" = Cmd+Enter sends */
  messageSendMode?: MessageSendMode

  /** Auto-focus the editor when mounted */
  autoFocus?: boolean

  /**
   * Mount with the mobile chrome (action bar + full editor) already open rather
   * than the compacted single-line resting state. For tap-to-open inline
   * composers (e.g. the board reply) the user has explicitly revealed the
   * composer, so it shouldn't step through the compacted phase before the
   * toolbar appears. Desktop always shows the chrome, so this is a no-op there.
   * Default false (the timeline/thread composers rest compacted on mobile).
   */
  initialMobileChromeOpen?: boolean

  /** Scope identifier — when it changes, re-focus the editor (if autoFocus) */
  scopeId?: string

  /** Called when ArrowUp is pressed in an empty editor — triggers edit-last-message */
  onEditLastMessage?: () => void

  /**
   * Called when Escape blurs the editor (only fires when no suggestion popup is
   * active — the popup consumes Escape first). Lets a host collapse a tap-to-open
   * inline composer on Escape without fighting the @/emoji/slash popovers.
   */
  onEscapeBlur?: () => void

  /**
   * Called when the editor gains focus. Fires on every focus (clicks, tab-backs),
   * so a consumer that only wants the FIRST focus of a session must dedupe —
   * see `useComposeTrace`.
   */
  onComposerFocus?: () => void

  /** Called when the desktop expand button is clicked — opens fullscreen document editor */
  onExpandClick?: () => void

  /** When true, the composer fills its container with full-height editor and always-visible toolbar */
  expanded?: boolean
  /** Called to collapse the expanded editor back to inline mode */
  onCollapse?: () => void
  /**
   * Suppress the expanded editor's own toolbar close (X) — for overlay hosts that
   * render their own close in a surrounding header, so the affordance isn't doubled.
   */
  hideExpandedClose?: boolean
  /** Stream context for filtering which broadcast mentions (@channel, @here) are available */
  streamContext?: MentionStreamContext
  /** Imperative handle ref for programmatic focus from parent */
  composerRef?: React.MutableRefObject<ComposerControlHandle | null>

  /**
   * Triggered when the user presses Cmd/Ctrl+S with focus inside the composer,
   * or when they click "Save current" in the stashed-drafts picker. The host
   * is responsible for snapshotting the current content/attachments, adding a
   * row to the stash, and clearing the active draft. An
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
  onCancelAttachmentUpload,
  contextRefs,
  streamId,
  memoAnchorStreamId = streamId,
  commandStreamId,
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
  initialMobileChromeOpen = false,
  scopeId,
  onEditLastMessage,
  onEscapeBlur,
  onComposerFocus,
  onExpandClick,
  expanded = false,
  onCollapse,
  hideExpandedClose = false,
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

  useEffect(() => {
    if (!streamId) return
    const consumeRequest = () => {
      const command = consumeComposerCommandRequest(streamId)
      if (!command) return
      onContentChange(prependComposerCommand(content, command))
      requestAnimationFrame(() => richEditorRef.current?.focus())
    }
    consumeRequest()
    return subscribeComposerCommandRequest(streamId, consumeRequest)
  }, [content, onContentChange, streamId])
  const mobileRootRef = useRef<HTMLDivElement>(null)
  const expandedShellRef = useRef<HTMLDivElement>(null)
  const actionBarWrapperRef = useRef<HTMLDivElement>(null)
  const [mobileToolbarEditor, setMobileToolbarEditor] = useState<Editor | null>(null)
  const [formatOpen, setFormatOpen] = useState(false)
  const [isInTable, setIsInTable] = useState(false)
  const [mobileExpanded, setMobileExpanded] = useState(false)
  // Expanded-mode FAB actions are always visible on desktop. Touch has no hover,
  // so a tap on the "+" toggles them instead.
  const [fabActionsOpen, setFabActionsOpen] = useState(false)
  // Every drawer action collapses the drawer once it's done its job — the "+"
  // toggle is for browsing, not a mode the user should have to un-toggle.
  const closeFabDrawer = useCallback(() => setFabActionsOpen(false), [])
  const [mobileFocused, setMobileFocused] = useState(initialMobileChromeOpen)
  const [mobileLinkPopoverOpen, setMobileLinkPopoverOpen] = useState(false)
  // True while a dictation take is in flight. Keeps the mobile chrome (and the
  // mic button it lives in) mounted across a tap-outside blur so the session
  // isn't torn down mid-take.
  const [voiceActive, setVoiceActive] = useState(false)
  const isMobile = useIsMobile()
  const actionSide = useComposerActionSide()
  const mirrored = actionSide === "left"
  // Selection toolbar is a hover/mouse affordance, so it keys off the active
  // input mode (a finger suppresses it) rather than viewport width — a mouse on
  // a touchscreen laptop still gets it.
  const disableSelectionToolbar = useInputMode() === "touch"
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const instructionsId = useId()

  // Mobile chrome (action bar + full editor) stays open while focused OR while
  // a dictation take is in flight (see mobileChromeOpen below). Mirrored in a
  // ref so the stable focus handlers can read the current value.
  const mobileChromeOpen = mobileFocused || voiceActive
  const mobileChromeOpenRef = useRef(mobileChromeOpen)
  mobileChromeOpenRef.current = mobileChromeOpen

  // Defer the mobile chrome expansion until the keyboard's viewport resize
  // lands. Expanding on focus alone ran ~100ms ahead of the keyboard, so the
  // open read as two snaps: content nudged up for the taller composer, then
  // the keyboard jump. Waiting for the first visualViewport resize after the
  // focus — and rendering synchronously inside that event, in the same frame
  // useVisualViewport writes --viewport-height — fuses both into ONE snap
  // (the timeline ResizeObserver sees one combined layout change and pins
  // once). The timeout is the fallback for keyboards that never resize the
  // viewport (hardware keyboard); an already-open chrome skips the wait.
  const pendingChromeOpenRef = useRef<(() => void) | null>(null)
  const cancelPendingChromeOpen = useCallback(() => {
    pendingChromeOpenRef.current?.()
    pendingChromeOpenRef.current = null
  }, [])
  const openMobileChromeWithKeyboard = useCallback(() => {
    if (mobileChromeOpenRef.current) {
      setMobileFocused(true)
      return
    }
    if (pendingChromeOpenRef.current) return
    const vv = window.visualViewport
    if (!vv) {
      setMobileFocused(true)
      return
    }
    const open = () => {
      cancel()
      // The viewport resize that arrives when focus has already LEFT the
      // composer is the keyboard closing, not opening — never expand on it.
      const root = mobileRootRef.current
      if (root && !root.contains(document.activeElement)) return
      flushSync(() => setMobileFocused(true))
      // Re-assert focus for the tap-to-reveal path, where the editor was
      // focused while still zero-height.
      richEditorRef.current?.focus()
    }
    const timeoutId = window.setTimeout(open, KEYBOARD_RESIZE_WAIT_MS)
    // Both browsers dispatch `window` resize BEFORE visualViewport resize
    // (separate events) — useVisualViewport writes --viewport-height on
    // whichever lands first, so the chrome must open on the first of the two
    // or it trails the keyboard snap by a dispatch and reads as a second
    // phase. The handlers run after useVisualViewport's (attached earlier),
    // so the flushSync render shares the height write's frame.
    vv.addEventListener("resize", open)
    window.addEventListener("resize", open)
    const cancel = () => {
      pendingChromeOpenRef.current = null
      clearTimeout(timeoutId)
      vv.removeEventListener("resize", open)
      window.removeEventListener("resize", open)
    }
    pendingChromeOpenRef.current = cancel
  }, [])

  // Imperative handle to the live mic button so the composer can end the
  // dictation take when it sends or clears the draft (drops the polish toggle
  // and any warning chrome rather than letting them ride out a timer).
  const micRef = useRef<MicButtonHandle | null>(null)
  // Edge-detect the composer emptying (send-clear, manual delete, stash) so we
  // tear down the dictation session exactly once on the non-empty → empty transition.
  const wasEmptyRef = useRef(isEmptyContent(content))
  useEffect(() => {
    const empty = isEmptyContent(content)
    const wasEmpty = wasEmptyRef.current
    wasEmptyRef.current = empty
    if (empty && !wasEmpty) micRef.current?.abort()
  }, [content])

  // Close inline format toolbar and collapse expansion when navigating to a different stream/scope.
  // Clearing voiceActive collapses the mobile chrome; combined with the scopeId-keyed mic below,
  // an in-flight dictation take ends on navigation rather than carrying over into the next stream.
  // The first run (mount) is skipped so an opt-in initialMobileChromeOpen isn't cleared before it
  // shows; the reset only matters on a later scope CHANGE. For every existing caller the mount-time
  // state is already all-closed, so skipping that run is a no-op for them.
  const didMountScopeResetRef = useRef(false)
  useEffect(() => {
    if (!didMountScopeResetRef.current) {
      didMountScopeResetRef.current = true
      return
    }
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current)
      blurTimeoutRef.current = null
    }
    cancelPendingChromeOpen()
    setFormatOpen(false)
    setMobileExpanded(false)
    setMobileFocused(false)
    setMobileLinkPopoverOpen(false)
    setVoiceActive(false)
  }, [scopeId, cancelPendingChromeOpen])

  // Reset mobile-only state when viewport crosses the mobile/desktop threshold
  useEffect(() => {
    if (!isMobile) {
      cancelPendingChromeOpen()
      setMobileExpanded(false)
      setMobileFocused(false)
      setMobileLinkPopoverOpen(false)
    }
  }, [isMobile, cancelPendingChromeOpen])

  // The collapsed mobile bar still hosts the live editor at zero height, and a
  // race can leave DOM focus inside it — e.g. a stream switch collapses the
  // chrome without blurring (link taps don't blur contentEditable on iOS), and
  // the draft-swap setContent then re-asserts focus (apply-external-content).
  // Keystrokes into that hidden editor land with the caret clamped to the doc
  // start, so text comes out reversed. Typing is proof the user has focus:
  // reveal the chrome instead of swallowing input. flushSync so the editor is
  // visible before the browser applies this very input event; the selection is
  // untouched (the editor never unmounts and nothing calls focus()).
  useEffect(() => {
    if (!isMobile || mobileChromeOpen || expanded) return
    const root = mobileRootRef.current
    if (!root) return
    const reveal = () => {
      cancelPendingChromeOpen()
      flushSync(() => setMobileFocused(true))
    }
    root.addEventListener("beforeinput", reveal, true)
    root.addEventListener("compositionstart", reveal, true)
    return () => {
      root.removeEventListener("beforeinput", reveal, true)
      root.removeEventListener("compositionstart", reveal, true)
    }
  }, [isMobile, mobileChromeOpen, expanded, cancelPendingChromeOpen])

  // Track focus state for mobile progressive disclosure.
  // Uses a small delay on blur to avoid flicker when focus moves between editor and action bar buttons.
  const handleFocusCapture = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current)
        blurTimeoutRef.current = null
      }
      // An editor focus raises the keyboard — open the chrome together with
      // its resize (one snap). Focus landing on other controls (the preview
      // send button) raises no keyboard, so there is nothing to wait for.
      if (e.target instanceof HTMLElement && e.target.isContentEditable) {
        openMobileChromeWithKeyboard()
      } else {
        setMobileFocused(true)
      }
    },
    [openMobileChromeWithKeyboard]
  )

  const handleBlurCapture = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current)
        blurTimeoutRef.current = null
      }
      const root = e.currentTarget
      // Focus hopping to another control *inside* the composer (a toolbar button,
      // the link popover) must keep the mobile chrome open — never collapse.
      const related = e.relatedTarget as Node | null
      if (related && root.contains(related)) return

      const collapse = () => {
        blurTimeoutRef.current = null
        // A within-composer refocus that landed a tick later (mobile toolbar taps
        // where relatedTarget is null) cancels the collapse.
        if (root.contains(document.activeElement)) return
        cancelPendingChromeOpen()
        setMobileFocused(false)
        setMobileExpanded(false)
        setFormatOpen(false)
        setMobileLinkPopoverOpen(false)
      }
      // Focus is leaving the composer (tap outside → keyboard closing). Collapse on
      // the next tick instead of after 150ms, so the chrome shrink runs *together*
      // with the keyboard-close viewport change rather than landing afterward as a
      // separate, jarring second step. The one-tick defer (not synchronous) still
      // lets a refocus into the composer cancel it via the activeElement guard.
      blurTimeoutRef.current = setTimeout(collapse, 0)
    },
    [cancelPendingChromeOpen]
  )

  // Cleanup timeouts/listeners on unmount
  useEffect(
    () => () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
      cancelPendingChromeOpen()
    },
    [cancelPendingChromeOpen]
  )

  // Track whether the caret is inside a table so we can surface a discoverability
  // hint on mobile — the floating selection toolbar is suppressed on mobile, so
  // without this hint there's no visible cue that the format toolbar holds row
  // and column controls.
  useEffect(() => {
    if (!mobileToolbarEditor) {
      setIsInTable(false)
      return
    }
    const update = () => setIsInTable(mobileToolbarEditor.isActive("table"))
    update()
    mobileToolbarEditor.on("selectionUpdate", update)
    mobileToolbarEditor.on("update", update)
    return () => {
      mobileToolbarEditor.off("selectionUpdate", update)
      mobileToolbarEditor.off("update", update)
    }
  }, [mobileToolbarEditor])

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
  const previewText = useMemo(() => collapsedComposerPreview(content), [content])

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [fileInputRef])

  // Stable wrappers that read the editor handle at call time (not render time),
  // so they stay fresh whether invoked from an inline toolbar button or a
  // folded "+" overflow menu item.
  const insertEmoji = useCallback(() => richEditorRef.current?.insertEmoji(), [])
  const insertMention = useCallback(() => richEditorRef.current?.insertMention(), [])
  const insertSlash = useCallback(() => richEditorRef.current?.insertSlash(), [])

  const handleSubmit = useCallback(() => {
    setFormatOpen(false)
    setMobileExpanded(false)
    setMobileLinkPopoverOpen(false)
    // End any in-flight take first: this flushes the live hypothesis into the
    // editor (so the tail lands in the message) and drops the polish toggle +
    // warnings before we snapshot the content below.
    micRef.current?.prepareSendAsIs()
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
      // Mirror focus(): on mobile the editor only mounts once focused, so reveal
      // it first, then open the snippet editor on the next frame.
      openSnippetEditor: () => {
        setMobileFocused(true)
        requestAnimationFrame(() => richEditorRef.current?.openSnippetEditor())
      },
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

  // Cmd/Ctrl+S with nothing to stash flips to "show me my drafts": open the
  // hosted picker (registered via context — the picker is a slot node).
  const stashedDraftsOpenRef = useRef<(() => void) | null>(null)
  const stashedDraftsBridge = useMemo<StashedDraftsComposerBridge>(
    () => ({
      openRef: stashedDraftsOpenRef,
      focusComposer: () => richEditorRef.current?.focus(),
    }),
    []
  )
  const composerEmpty = isEmptyContent(content) && pendingAttachments.length === 0

  const handleStashKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!stashBinding) return
      if (!matchesKeyBinding(event.nativeEvent, stashBinding)) return

      event.preventDefault()
      event.stopPropagation()
      if (composerEmpty) {
        stashedDraftsOpenRef.current?.()
        return
      }
      onStashDraft?.()
    },
    [onStashDraft, stashBinding, composerEmpty]
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
      disableSelectionToolbar={disableSelectionToolbar}
      onEditLastMessage={onEditLastMessage}
      onEscapeBlur={onEscapeBlur}
      onFocus={onComposerFocus}
      ariaLabel="Message input"
      ariaDescribedBy={instructionsId}
      blurOnEscape
      streamContext={streamContext}
      memoAnchorStreamId={memoAnchorStreamId}
      commandStreamId={commandStreamId}
    />
  )

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

  // Always available on workspace surfaces so dictation can be resumed after the
  // composer already has text — appended at the caret like committed speech.
  const insertTranscribedText = useCallback((text: string) => richEditorRef.current?.insertTranscribedText(text), [])
  const setDictationInterim = useCallback((text: string) => richEditorRef.current?.setDictationInterim(text), [])
  // Polished-chunk wiring: the editor tracks each polished chunk by id so a
  // session-wide toggle can swap them in-place between polished and raw.
  const insertPolishedDictationChunk = useCallback(
    (args: { chunkId: string; text: string }) => richEditorRef.current?.insertDictationChunk(args),
    []
  )
  const swapDictationChunk = useCallback(
    (args: { chunkId: string; newText: string; expectedText: string }) =>
      richEditorRef.current?.replaceDictationChunkText(args) ?? false,
    []
  )
  const lockAllDictationChunks = useCallback(() => richEditorRef.current?.lockAllDictationChunks(), [])
  const getDictationChunkText = useCallback(
    (chunkId: string) => richEditorRef.current?.getDictationChunkText(chunkId) ?? null,
    []
  )
  // Draft text around the caret, captured when a take starts and sent as
  // read-only context for the polish model — so dictated corrections can match
  // the spelling of names/terms already in the message and the polished text
  // flows with the sentence it lands in. Plain text is intentional here: this
  // is model context, not message content (the INV-58 contentJson rule governs
  // what we store/send as content, not what we show a model).
  const getDictationDraftContext = useCallback(() => {
    const editor = richEditorRef.current?.getEditor()
    if (!editor) return null
    const { doc, selection } = editor.state
    return {
      before: doc.textBetween(0, selection.from, "\n"),
      after: doc.textBetween(selection.to, doc.content.size, "\n"),
    }
  }, [])
  // Keyed by scopeId so navigating to a different stream remounts the button, tearing down any
  // in-flight dictation session (the unmount cleanup aborts the take) instead of carrying it over.
  const micButton = workspaceId ? (
    <MicButton
      key={`mic-${scopeId ?? ""}`}
      ref={micRef}
      workspaceId={workspaceId}
      onInsertText={insertTranscribedText}
      onInterimText={setDictationInterim}
      onActiveChange={setVoiceActive}
      onInsertPolishedChunk={insertPolishedDictationChunk}
      onChunkSwap={swapDictationChunk}
      onLockAllChunks={lockAllDictationChunks}
      onGetChunkText={getDictationChunkText}
      onGetDraftContext={getDictationDraftContext}
      disabled={controlsDisabled}
    />
  ) : null
  const micButtonFab = workspaceId ? (
    <MicButton
      key={`mic-fab-${scopeId ?? ""}`}
      ref={micRef}
      workspaceId={workspaceId}
      onInsertText={insertTranscribedText}
      onInterimText={setDictationInterim}
      onActiveChange={setVoiceActive}
      onInsertPolishedChunk={insertPolishedDictationChunk}
      onChunkSwap={swapDictationChunk}
      onLockAllChunks={lockAllDictationChunks}
      onGetChunkText={getDictationChunkText}
      onGetDraftContext={getDictationDraftContext}
      disabled={controlsDisabled}
      className="h-[30px] w-[30px] rounded-md border bg-background shadow-md"
    />
  ) : null

  const expandedTrailingContent =
    expanded && !hideExpandedClose ? (
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
        <StashedDraftsComposerBridgeContext.Provider value={stashedDraftsBridge}>
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
                if ((e.target as HTMLElement).closest("button,a,input,textarea,[contenteditable],[role='button']"))
                  return
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
                onFocus={onComposerFocus}
                toolbarTrailingContent={expandedTrailingContent}
                ariaLabel="Fullscreen message editor"
                ariaDescribedBy={instructionsId}
                blurOnEscape
                onEscapeBlur={focusExpandedShell}
                streamContext={streamContext}
                memoAnchorStreamId={memoAnchorStreamId}
                commandStreamId={commandStreamId}
                belowToolbarContent={
                  pendingAttachments.length > 0 || (contextRefs && contextRefs.length > 0) ? (
                    <div className="pt-1 pb-2 border-b border-border/50 [&>div]:mb-0">
                      <PendingAttachments
                        attachments={pendingAttachments}
                        onRemove={onRemoveAttachment}
                        onCancelUpload={onCancelAttachmentUpload}
                        workspaceId={workspaceId}
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

            <div
              className={cn(
                "absolute bottom-[max(1rem,env(safe-area-inset-bottom))] z-10 flex items-center gap-1.5",
                mirrored ? "left-4 flex-row-reverse" : "right-4"
              )}
            >
              {/* Action drawer — always visible on desktop; on touch (no hover) it
                stays behind the + button and opens on tap. `inert` while
                collapsed on mobile so its buttons drop out of tab order instead
                of sitting invisibly ahead of the visible "+" button. */}
              <div
                inert={isMobile && !fabActionsOpen}
                className={cn(
                  "flex items-center gap-1 overflow-hidden transition-all duration-200 ease-out",
                  mirrored && "flex-row-reverse",
                  isMobile ? "max-w-0 opacity-0" : "max-w-[240px] opacity-100",
                  fabActionsOpen && "max-w-[240px] opacity-100"
                )}
              >
                <FabDrawerCloseContext.Provider value={closeFabDrawer}>
                  {stashedDraftsTriggerFab}
                  {scheduledMessagesTriggerFab}
                </FabDrawerCloseContext.Provider>
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
                        closeFabDrawer()
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
                        closeFabDrawer()
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
                        closeFabDrawer()
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
                      onClick={() => {
                        closeFabDrawer()
                        handleAttachClick()
                      }}
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
              {isMobile ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={fabActionsOpen ? "Hide actions" : "Show actions"}
                  aria-expanded={fabActionsOpen}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => setFabActionsOpen((v) => !v)}
                  className={cn(
                    "h-[30px] w-[30px] shrink-0 p-0 rounded-md bg-background shadow-md [&_svg]:transition-transform",
                    fabActionsOpen && "[&_svg]:rotate-45"
                  )}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              ) : null}
              {micButtonFab}
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
                  <TooltipContent side={mirrored ? "right" : "left"} className="text-xs">
                    {sendHint}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </StashedDraftsComposerBridgeContext.Provider>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <StashedDraftsComposerBridgeContext.Provider value={stashedDraftsBridge}>
        {/* Message input wrapper — dvh units respect the virtual keyboard on mobile */}
        <div
          ref={mobileRootRef}
          data-composer-expanded={mobileExpanded ? true : undefined}
          className={cn(
            // No transition on max/min-height: animating the shell's layout box
            // re-runs layout every frame, and the timeline scroller above resizes
            // with it — each frame fires its ResizeObserver, re-pins to bottom,
            // and forces a virtua re-measure (~10fps on low-end Android, see
            // docs/stream-timeline-perceived-performance.md). Snap instead, same
            // as the keyboard choreography.
            "flex flex-col",
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
          <PendingAttachments
            attachments={pendingAttachments}
            onRemove={onRemoveAttachment}
            onCancelUpload={onCancelAttachmentUpload}
            workspaceId={workspaceId}
            beforePills={
              contextRefs && contextRefs.length > 0 && streamId && workspaceId ? (
                <ContextRefStrip workspaceId={workspaceId} streamId={streamId} draftRefs={contextRefs} />
              ) : null
            }
          />

          {/* Live in-app link previews for the draft. Above the card (like
            attachments) so they read as attached to this message and stay clear
            of the keyboard on mobile. Hidden in the mobile resting state to keep
            the single-line bar minimal. */}
          {workspaceId && (!isMobile || mobileChromeOpen) && (
            <ComposerLinkPreviews content={content} workspaceId={workspaceId} className="mb-2" />
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onFileSelect}
            disabled={controlsDisabled}
          />

          <div className="input-glow-wrapper flex-1 flex flex-col min-h-0">
            <div
              data-composer-card
              className={cn(
                "rounded-[16px] border border-input flex flex-col flex-1 min-h-0",
                // Floating-composer shadow on the inline (non-expanded) card; the
                // expanded fullscreen sheet stays flat.
                !mobileExpanded && COLLAPSED_COMPOSER_SHADOW,
                // Glass (translucent + backdrop-blur) lets the timeline show through
                // the floating composer, but backdrop-filter re-rasterizes the blurred
                // backdrop on every repaint — cheap on desktop, a frame-killer on
                // mobile over a long, image-heavy timeline while typing. Opaque on
                // mobile; keep the glass on desktop where the GPU absorbs it.
                !mobileExpanded && !isMobile ? "bg-card/75 backdrop-blur-md" : "bg-card",
                // Compact padding when mobile-unfocused (single line), normal otherwise
                isMobile && !mobileChromeOpen ? "px-3 py-2" : "p-3 gap-2",
                // When mobile-expanded, let the editor grow and override its internal max-height
                mobileExpanded && "[&_.tiptap]:max-h-none"
              )}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button,a,input,textarea,[contenteditable],[role='button']"))
                  return
                // On mobile unfocused, focus the (still zero-height) editor now —
                // raising the keyboard — and expand the chrome together with the
                // keyboard's viewport resize, so the open is a single snap.
                if (isMobile && !mobileChromeOpen) {
                  openMobileChromeWithKeyboard()
                  richEditorRef.current?.focus()
                  return
                }
                richEditorRef.current?.focus()
              }}
            >
              {isMobile && !mobileChromeOpen && (
                <div
                  className={cn(
                    COLLAPSED_COMPOSER_ROW,
                    "text-sm select-none pointer-events-none",
                    mirrored && "flex-row-reverse"
                  )}
                >
                  <span className="flex-1 min-w-0 truncate text-muted-foreground">{previewText || placeholder}</span>
                  <div className="pointer-events-auto">{sendButton}</div>
                </div>
              )}

              {/* Mobile-only table hint — the floating selection toolbar is
               suppressed on mobile (it conflicts with the OS selection popup),
               so without this banner there's no visible cue that the row /
               column / delete controls live behind the Aa button. */}
              {isMobile && mobileChromeOpen && isInTable && !formatOpen && (
                <button
                  type="button"
                  onClick={() => setFormatOpen(true)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="flex items-center gap-2 self-start rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                >
                  Editing table — tap{" "}
                  <span className="rounded bg-background px-1 py-0.5 text-[11px] font-bold leading-none">Aa</span> to
                  add or delete rows and columns
                </button>
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
                      side={actionSide}
                      trailingContent={
                        micButton || stashedDraftsTrigger || scheduledMessagesTrigger ? (
                          // Mirrored too, so Send stays the outermost control
                          // rather than sitting behind the triggers.
                          <div className={cn("flex items-center gap-1", mirrored && "flex-row-reverse")}>
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
                    <ComposerActionBar
                      side={actionSide}
                      disabled={controlsDisabled}
                      formatOpen={formatOpen}
                      onToggleFormat={() => setFormatOpen((v) => !v)}
                      onInsertEmoji={insertEmoji}
                      onInsertMention={insertMention}
                      onInsertCommand={insertSlash}
                      onAttachClick={handleAttachClick}
                      onExpandClick={onExpandClick}
                      micButton={micButton}
                      stashedDraftsTrigger={stashedDraftsTrigger}
                      scheduledMessagesTrigger={scheduledMessagesTrigger}
                      sendButton={sendButton}
                    />
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

          <div className={cn("flex px-1 pt-1", mirrored ? "justify-start" : "justify-end")}>
            <span className="text-[10px] text-muted-foreground opacity-60 hidden sm:block select-none pointer-events-none">
              {sendHint}
            </span>
          </div>
        </div>
      </StashedDraftsComposerBridgeContext.Provider>
    </TooltipProvider>
  )
}
