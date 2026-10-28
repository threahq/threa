import { useState, useEffect, useCallback, useRef, useId, useMemo } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { enqueueOperation } from "@/sync/operation-queue"
import { isPermanentApiError } from "@/api"
import { isPrivacyConfirmationError } from "@/lib/share-privacy-toast"
import { useSharePrivacyConfirm } from "@/hooks/use-share-privacy-confirm"
import { Expand } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import {
  RichEditor,
  EditorToolbar,
  EditorActionBar,
  DocumentEditorModal,
  isDocCreatePending,
} from "@/components/editor"
import type { RichEditorHandle } from "@/components/editor"
import { inAppLinkMarksToNodes } from "@/components/editor/in-app-link-marks"
import { AskOverlay, SendAskRow, SendWarningBadge } from "@/components/composer/send-ask"
import { useEditorSendAsk } from "@/components/composer/use-editor-send-ask"
import type { ComposerSubmitOptions } from "@/components/composer"
import { referenceAudienceTargetFor, useReferenceAudience } from "@/hooks/use-reference-audience"
import { useInputMode } from "@/hooks/use-input-mode"
import { usePaneCovered } from "@/components/panes/pane-host"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useMessageService } from "@/contexts"
import { messageKeys } from "@/api/messages"
import { serializeToMarkdown, parseMarkdown } from "@threahq/prosemirror"
import type { JSONContent } from "@threahq/types"
import type { Editor } from "@tiptap/react"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { unstampedMarkdown } from "@/lib/display-stamps"
import { useStreamFromStore } from "@/stores/stream-store"
import { useStableCallback } from "@/hooks/use-stable-callback"

const MOD_KEY_NAME = navigator.platform?.toLowerCase().includes("mac") ? "Command" : "Control"

interface MessageEditFormProps {
  messageId: string
  workspaceId: string
  /** The stream this message belongs to — scopes the `/memos` picker. */
  streamId: string
  initialContentJson?: JSONContent
  onSave: () => void
  onCancel: () => void
  /** Called when the user submits with empty content, signalling intent to delete */
  onDelete?: () => void
  /** Author display name — shown in the mobile drawer header for context */
  authorName?: string
}

export function MessageEditForm({
  messageId,
  workspaceId,
  streamId,
  initialContentJson,
  onSave,
  onCancel,
  onDelete,
  authorName,
}: MessageEditFormProps) {
  const queryClient = useQueryClient()
  const messageService = useMessageService()
  const stream = useStreamFromStore(workspaceId, streamId)
  const streamContext = useMentionStreamContext(workspaceId, stream)
  // Latch the surface at mount: input mode is live, so reading it directly would
  // flip drawer<->inline mid-edit and remount the editor, dropping unsaved text.
  const [isTouch] = useState(useInputMode() === "touch")
  // The `data-inline-edit` wrapper below drives the mobile composer visibility
  // through the body-level inline-edit presence attribute.
  // Re-chip in-app stream/message links the composer once chipped: the stored
  // body carries them as plain link marks, so without this an edit shows raw
  // links instead of the chips the message renders.
  const [contentJson, setContentJson] = useState<JSONContent>(() =>
    inAppLinkMarksToNodes(initialContentJson ?? EMPTY_DOC)
  )
  const contentRef = useRef(contentJson)
  contentRef.current = contentJson
  const [isSaving, setIsSaving] = useState(false)
  const [docEditorOpen, setDocEditorOpen] = useState(false)
  const [initialContent] = useState(contentJson)
  // Chips stamp their resolved labels in on mount; an untouched edit must still read as unchanged.
  const [initialMarkdown] = useState(() => unstampedMarkdown(contentJson))
  const { sendWarning, audienceByStreamId, awaitSendWarning, sentReferenceKeys } = useReferenceAudience({
    workspaceId,
    target: referenceAudienceTargetFor(streamId, stream),
    content: contentJson,
    previousContent: initialContent,
  })
  const [formatOpen, setFormatOpen] = useState(false)
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const [mobileLinkPopoverOpen, setMobileLinkPopoverOpen] = useState(false)
  const richEditorRef = useRef<RichEditorHandle>(null)
  const mobileActionBarRef = useRef<HTMLDivElement>(null)
  const drawerContentRef = useRef<HTMLDivElement>(null)
  const [mobileToolbarEditor, setMobileToolbarEditor] = useState<Editor | null>(null)
  const instructionsId = useId()
  const covered = usePaneCovered()
  const {
    question,
    submit: submitAsking,
    dismiss: dismissQuestion,
    answerQuestion,
    escapeQuestion,
    takeAlternative,
    labelWithWarning,
    warning,
  } = useEditorSendAsk({
    sendWarning,
    awaitSendWarning,
    content: contentJson,
    editorRef: richEditorRef,
    workspaceId,
    compact: isTouch,
    sentReferenceKeys,
  })

  useEffect(() => {
    if (isTouch) return // vaul handles Escape via onOpenChange
    // A background tab keeps its edit open; Escape belongs to the tab on show.
    if (covered) return
    // The full editor owns Escape while it is open.
    if (docEditorOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (escapeQuestion(e)) return
      e.preventDefault()
      onCancel()
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [isTouch, covered, docEditorOpen, escapeQuestion, onCancel])

  const setRichEditorHandle = useCallback((handle: RichEditorHandle | null) => {
    richEditorRef.current = handle
    const nextEditor = handle?.getEditor() ?? null
    setMobileToolbarEditor((currentEditor) => (currentEditor === nextEditor ? currentEditor : nextEditor))
  }, [])

  const { clear: clearPrivacyBlock, block: blockOnPrivacy } = useSharePrivacyConfirm({
    toastId: `share-privacy-edit-${messageId}`,
    content: contentJson,
    confirmLabel: "Save anyway",
    onConfirm: () => void saveEdit(contentRef.current, true),
  })

  const saveEdit = useCallback(
    async (json: JSONContent, confirmedPrivacyWarning?: boolean): Promise<void> => {
      clearPrivacyBlock()
      setIsSaving(true)
      try {
        await messageService.update(workspaceId, messageId, {
          contentJson: json,
          confirmedPrivacyWarning,
        })
        queryClient.invalidateQueries({ queryKey: messageKeys.versions(workspaceId, messageId) })
        onSave()
      } catch (err) {
        // Typing during the save moved the form on; the toast asks about what it shows now.
        if (isPrivacyConfirmationError(err)) {
          blockOnPrivacy(contentRef.current)
          return
        }
        if (isPermanentApiError(err)) {
          toast.error("Couldn't save your edit.")
          return
        }
        await enqueueOperation(workspaceId, "edit_message", {
          messageId,
          contentJson: json,
          confirmedPrivacyWarning,
        })
        onSave() // Close the edit form — the edit will be retried
        toast.info("Edit queued — will be saved when back online")
      } finally {
        setIsSaving(false)
      }
    },
    [workspaceId, messageId, onSave, queryClient, messageService, clearPrivacyBlock, blockOnPrivacy]
  )

  // Stable, so an answer given after a rerender saves through the current `saveEdit`.
  const save = useStableCallback((options?: ComposerSubmitOptions) => {
    const editor = richEditorRef.current?.getEditor()
    if (editor && isDocCreatePending(editor)) return
    setFormatOpen(false)
    setMobileExpanded(false)
    setMobileLinkPopoverOpen(false)
    void saveEdit(contentRef.current, options?.confirmedPrivacyWarning)
  })

  const handleSubmit = useCallback(() => {
    if (isSaving) return
    if (!serializeToMarkdown(contentJson).trim()) {
      onDelete?.()
      return
    }
    if (unstampedMarkdown(contentJson) === initialMarkdown) {
      onCancel()
      return
    }
    void submitAsking(save, "Save")
  }, [isSaving, contentJson, initialMarkdown, onCancel, onDelete, submitAsking, save])

  // The full editor's content has to render before the ask can see its refs.
  const submitDocEditorOnRender = useRef(false)
  useEffect(() => {
    if (!submitDocEditorOnRender.current) return
    submitDocEditorOnRender.current = false
    void submitAsking(save, "Save")
  }, [contentJson, submitAsking, save])

  const handleDocEditorSend = useCallback(
    (markdown: string) => {
      const trimmed = markdown.trim()
      if (!trimmed) {
        setDocEditorOpen(false)
        onDelete?.()
        return
      }
      const content = inAppLinkMarksToNodes(parseMarkdown(trimmed))
      setDocEditorOpen(false)
      if (unstampedMarkdown(content) === initialMarkdown) {
        onCancel()
        return
      }
      // A refused or questioned save keeps the form open, so it must hold what the full editor sent.
      setContentJson(content)
      submitDocEditorOnRender.current = true
    },
    [initialMarkdown, onCancel, onDelete]
  )

  const handleDocEditorDismiss = useCallback((markdown: string) => {
    const json = inAppLinkMarksToNodes(parseMarkdown(markdown))
    setContentJson(json)
  }, [])

  const isEmpty = useMemo(() => !serializeToMarkdown(contentJson).trim(), [contentJson])

  const screenReaderInstructions = useMemo(() => {
    if (isTouch) {
      return isEmpty
        ? `Press ${MOD_KEY_NAME}+Enter to delete. Tab and Shift+Tab indent content. Press Escape to leave the editor.`
        : `Press ${MOD_KEY_NAME}+Enter to save. Tab and Shift+Tab indent content. Press Escape to leave the editor.`
    }

    return isEmpty
      ? "Press Enter to delete. Tab and Shift+Tab indent content. Press Escape to cancel editing."
      : "Press Enter to save. Tab and Shift+Tab indent content. Press Escape to cancel editing."
  }, [isTouch, isEmpty])

  const focusMobileActionBar = useCallback(() => {
    mobileActionBarRef.current?.focus()
  }, [])

  const saveLabel = isSaving ? "Saving..." : "Save"
  const saveBadge = warning ? <SendWarningBadge tone={warning.tone} /> : null
  const askRow = question ? (
    <SendAskRow
      tone={question.tone}
      copy={question.copy}
      compact={isTouch}
      onPrimary={answerQuestion}
      onAlternative={takeAlternative}
      detail={{ workspaceId, lead: question.lead }}
      className="w-full"
    />
  ) : null

  if (isTouch) {
    const trailingContent = (
      <>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Cancel edit"
          className="h-8 px-2.5 text-xs shrink-0"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onCancel}
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          aria-label={labelWithWarning(isSaving ? "Saving..." : "Save edit")}
          className="relative h-8 px-3 text-xs shrink-0"
          onPointerDown={(e) => e.preventDefault()}
          onClick={handleSubmit}
          disabled={isSaving}
        >
          {saveLabel}
          {saveBadge}
        </Button>
      </>
    )

    return (
      <Drawer
        open
        onOpenChange={(open) => {
          if (!open) setTimeout(onCancel, 300)
        }}
      >
        <DrawerContent
          ref={drawerContentRef}
          onEscapeKeyDown={escapeQuestion}
          onPointerDownOutside={(e) => {
            // The "Save anyway" toast lives outside the drawer; pressing it must not close the edit.
            if ((e.target as HTMLElement).closest("[data-sonner-toaster]")) e.preventDefault()
          }}
          className={mobileExpanded ? "!h-[100dvh] rounded-t-none" : "max-h-[85dvh]"}
        >
          <DrawerTitle className="sr-only">Edit message</DrawerTitle>
          <p id={instructionsId} className="sr-only">
            {screenReaderInstructions}
          </p>

          <div className="flex flex-col flex-1 min-h-0 px-4 pt-1">
            {authorName && <p className="text-[13px] font-semibold text-muted-foreground mb-1">{authorName}</p>}

            <div
              data-inline-edit
              className="flex-1 min-h-0 overflow-y-auto [&_.tiptap]:!pt-0 [&_.tiptap_p]:!leading-relaxed [&_.tiptap]:max-h-none [&_.tiptap]:min-h-full"
            >
              <RichEditor
                ref={setRichEditorHandle}
                value={contentJson}
                onChange={setContentJson}
                onSubmit={handleSubmit}
                onFocus={dismissQuestion}
                audienceByStreamId={audienceByStreamId}
                placeholder="Edit message..."
                ariaLabel="Edit message"
                ariaDescribedBy={instructionsId}
                messageSendMode="cmdEnter"
                autoFocus
                disableSelectionToolbar
                blurOnEscape
                onEscapeBlur={focusMobileActionBar}
                memoAnchorStreamId={streamId}
                streamContext={streamContext}
              />
            </div>
          </div>

          <div
            ref={mobileActionBarRef}
            className="px-4 pb-[max(8px,env(safe-area-inset-bottom))]"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
          >
            <AskOverlay askRow={askRow}>
              <EditorActionBar
                editorHandle={richEditorRef.current}
                disabled={isSaving}
                formatOpen={formatOpen}
                onFormatOpenChange={setFormatOpen}
                mobileExpanded={mobileExpanded}
                onMobileExpandedChange={setMobileExpanded}
                showAttach={false}
                trailingContent={trailingContent}
              />
            </AskOverlay>
            {formatOpen && (
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
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <>
      <p id={instructionsId} className="sr-only">
        {screenReaderInstructions}
      </p>
      <div data-inline-edit className="[&_.tiptap]:!pt-0 [&_.tiptap_p]:!leading-relaxed">
        <RichEditor
          ref={richEditorRef}
          value={contentJson}
          onChange={setContentJson}
          onSubmit={handleSubmit}
          onFocus={dismissQuestion}
          audienceByStreamId={audienceByStreamId}
          placeholder="Edit message..."
          ariaLabel="Edit message"
          ariaDescribedBy={instructionsId}
          autoFocus
          memoAnchorStreamId={streamId}
          streamContext={streamContext}
        />
      </div>
      <AskOverlay askRow={askRow} className="mt-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground/70 hidden sm:flex items-center gap-1.5 mr-auto">
            <kbd className="kbd-hint">Esc</kbd> cancel
            <span className="text-muted-foreground/30">·</span>
            <kbd className="kbd-hint">↵</kbd> {isEmpty ? "delete" : "save"}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setDocEditorOpen(true)}
                disabled={isSaving}
              >
                <Expand className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Expand editor</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="relative h-6 px-2.5 text-xs"
            aria-label={labelWithWarning(saveLabel)}
            onClick={handleSubmit}
            disabled={isSaving}
          >
            {saveLabel}
            {saveBadge}
          </Button>
        </div>
      </AskOverlay>
      <DocumentEditorModal
        open={docEditorOpen}
        onOpenChange={setDocEditorOpen}
        initialContent={serializeToMarkdown(contentJson)}
        onSend={handleDocEditorSend}
        onDismiss={handleDocEditorDismiss}
        streamName="edit"
        streamContext={streamContext}
      />
    </>
  )
}
