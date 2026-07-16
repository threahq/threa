import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Send, Trash2 } from "lucide-react"
import type { Editor } from "@tiptap/react"
import { type JSONContent, type ScheduledMessageView } from "@threa/types"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { Button } from "@/components/ui/button"
import { RichEditor, EditorActionBar, EditorToolbar } from "@/components/editor"
import type { RichEditorHandle } from "@/components/editor"
import { PendingAttachments } from "@/components/timeline/pending-attachments"
import { DateTimeField } from "@/components/forms/date-time-field"
import { parseLocalDateTime, toDateInputValue, toTimeInputValue } from "@/lib/dates"
import { useIsMobile } from "@/hooks/use-mobile"
import { useInputMode } from "@/hooks/use-input-mode"
import {
  useUpdateScheduled,
  useLockScheduledForEdit,
  useReleaseScheduledEditLock,
  useSendScheduledNow,
  useCancelScheduled,
  isLocalScheduledId,
} from "@/hooks"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useAttachments } from "@/hooks/use-attachments"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { materializePendingAttachmentReferences } from "@/components/timeline/message-input"
import { toast } from "sonner"
import { collectAttachmentReferenceIds } from "@threa/prosemirror"
import { EMPTY_DOC, ensureTrailingParagraph } from "@/lib/prosemirror-utils"

interface ScheduledEditDialogProps {
  workspaceId: string
  scheduled: ScheduledMessageView | null
  onClose: () => void
}

/**
 * Edit modal for scheduled messages.
 *
 * Concurrency: optimistic CAS on `version` + worker pause-while-editing.
 * The dialog opens immediately seeded from the row the caller already has
 * (IDB or socket-fresh). On mount it fires `lockForEdit` once (no await,
 * no heartbeat) which bumps `edit_active_until` for ~10 minutes — the
 * worker checks this fence and defers firing while it's in the future, so
 * we don't ship mid-edit content. On save the PATCH carries
 * `expectedVersion = scheduled.version`; server CAS rejects with 409
 * STALE_VERSION if the row moved on. First save wins, second save toasts
 * and refreshes.
 *
 * Past-time saves transition `pending → sending → sent` atomically inside
 * the same PATCH on the backend (Save = Send semantics).
 */
export function ScheduledEditDialog({ workspaceId, scheduled, onClose }: ScheduledEditDialogProps) {
  const isMobile = useIsMobile()
  // Selection toolbar is a hover/mouse affordance, so it keys off the active
  // input mode (a finger suppresses it) rather than viewport width — a mouse on
  // a touchscreen laptop still gets it.
  const disableSelectionToolbar = useInputMode() === "touch"
  const updateMutation = useUpdateScheduled(workspaceId)
  const lockMutation = useLockScheduledForEdit(workspaceId)
  const releaseLockMutation = useReleaseScheduledEditLock(workspaceId)
  const sendNowMutation = useSendScheduledNow(workspaceId)
  const cancelMutation = useCancelScheduled(workspaceId)

  const [contentJson, setContentJson] = useState<JSONContent>(EMPTY_DOC)
  const [sendDate, setSendDate] = useState<string>("")
  const [sendTime, setSendTime] = useState<string>("")
  const [error, setError] = useState<string | null>(null)
  const [formatOpen, setFormatOpen] = useState(false)
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const [toolbarEditor, setToolbarEditor] = useState<Editor | null>(null)
  const editorRef = useRef<RichEditorHandle | null>(null)

  const idbStreams = useWorkspaceStreams(workspaceId)
  const destinationStream = useMemo(
    () => (scheduled?.streamId ? idbStreams.find((s) => s.id === scheduled.streamId) : undefined),
    [idbStreams, scheduled?.streamId]
  )
  const streamContext = useMentionStreamContext(workspaceId, destinationStream)
  const attachmentsHook = useAttachments(workspaceId)

  const open = scheduled !== null
  const isLocalRow = scheduled ? isLocalScheduledId(scheduled.id) : false

  /**
   * The `version` we'll send back as `expectedVersion`. Captured ONCE on
   * dialog open (state, not a memo on the prop) so a concurrent socket
   * update can't silently advance the version and let our save win where
   * it should have 409'd. Refreshed exactly once from the lock response —
   * that handles IDB rows that pre-date the version migration and don't
   * carry a `version` field. Without this refresh, the save guard
   * (`expectedVersion === null`) silently bails for those rows.
   */
  const [expectedVersion, setExpectedVersion] = useState<number | null>(null)

  // Seed editor state when the row id changes. Re-seeding mid-edit is
  // intentionally not done — that would clobber the user's in-progress edits
  // every time a socket event arrived.
  const previousIdRef = useRef<string | null>(null)
  useEffect(() => {
    const id = scheduled?.id ?? null
    if (previousIdRef.current === id) return
    previousIdRef.current = id

    if (!scheduled) {
      setContentJson(EMPTY_DOC)
      setSendDate("")
      setSendTime("")
      setError(null)
      setFormatOpen(false)
      setMobileExpanded(false)
      setExpectedVersion(null)
      attachmentsHook.clear()
      return
    }

    const at = new Date(scheduled.scheduledFor)
    // Append a trailing paragraph if the doc ends in a block-level atom
    // (quote-reply, shared-message). Without this, mobile users can't tap
    // a position after the atom — the gap-cursor has no tap target.
    setContentJson(ensureTrailingParagraph(scheduled.contentJson || EMPTY_DOC))
    setSendDate(toDateInputValue(at))
    setSendTime(toTimeInputValue(at))
    setError(null)
    setFormatOpen(false)
    setMobileExpanded(false)
    // Initial guess from the prop. May be undefined for IDB rows that
    // pre-date the version migration; the lock response below corrects it.
    setExpectedVersion(scheduled.version ?? null)
    attachmentsHook.clear()

    // Fire-and-forget pause + version refresh: pause the worker so it
    // doesn't send mid-edit, and use the response to refresh
    // `expectedVersion` (handles stale IDB rows missing `version`). Local
    // placeholders haven't been persisted yet — skip both.
    if (!isLocalScheduledId(scheduled.id)) {
      lockMutation
        .mutateAsync(scheduled.id)
        .then((res) => {
          setExpectedVersion(res.scheduled.version)
        })
        .catch(() => {
          // Lock failed (probably 409 NOT_PENDING — worker beat us). The
          // save will surface the same condition cleanly via STALE_VERSION
          // or NOT_PENDING; nothing to do here.
        })
    }
  }, [scheduled, attachmentsHook, lockMutation])

  const handleClose = useCallback(() => {
    // Fire-and-forget: drop the worker fence so the row can fire as soon
    // as its scheduled time arrives. Without this, cancelling out of the
    // dialog strands the row behind the 10-minute lock TTL — the worker
    // defers and the message lands up to 10 minutes late. Skip for local
    // rows (server doesn't know about them) and for terminal-state rows.
    if (scheduled && !isLocalScheduledId(scheduled.id) && scheduled.status === "pending") {
      releaseLockMutation.mutate(scheduled.id)
    }
    onClose()
  }, [scheduled, releaseLockMutation, onClose])

  const sendAtDate = useMemo(() => parseLocalDateTime(sendDate, sendTime), [sendDate, sendTime])

  const isPending = scheduled?.status === "pending"
  const isFailed = scheduled?.status === "failed"

  // Re-evaluate `isPast` on a 1s tick — without this, `isPast` is locked to
  // whatever it was when sendAtDate last changed, so a user who opened the
  // dialog 30s before the wire and kept editing past it would never see the
  // dialog flip into "Send" mode (title, save label, hint all stay on the
  // future-edit copy). The tick is gated behind `open` so the dialog
  // doesn't keep ticking after it's closed.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!open) return
    const handle = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(handle)
  }, [open])

  const isPast = useMemo(() => {
    if (!sendAtDate) return false
    return sendAtDate.getTime() <= now
  }, [sendAtDate, now])

  const setRichEditorHandle = useCallback((handle: RichEditorHandle | null) => {
    editorRef.current = handle
    const next = handle?.getEditor() ?? null
    setToolbarEditor((cur) => (cur === next ? cur : next))
  }, [])

  // Snapshot the live editor content + materialized attachments — shared by
  // Save and Send now so both ship exactly what the user currently sees.
  const collectEditorContent = useCallback(() => {
    const liveJson = (editorRef.current?.getEditor()?.getJSON() as JSONContent | undefined) ?? contentJson
    const materialized = materializePendingAttachmentReferences(
      liveJson,
      attachmentsHook.getPendingAttachmentsSnapshot()
    )
    return { contentJson: materialized, attachmentIds: collectAttachmentReferenceIds(materialized) }
  }, [contentJson, attachmentsHook])

  const handleSave = useCallback(async () => {
    if (!scheduled || !sendAtDate || expectedVersion === null) return
    if (isLocalRow) {
      // Local-only rows haven't been confirmed by the server yet, so the
      // update API would 404. The schedule_message op will land shortly;
      // until then, surface a benign hint and bail.
      toast.info("Scheduling… try again in a moment")
      return
    }
    try {
      const { contentJson: materialized, attachmentIds } = collectEditorContent()
      await updateMutation.mutateAsync({
        id: scheduled.id,
        input: {
          contentJson: materialized,
          scheduledFor: sendAtDate.toISOString(),
          attachmentIds,
          expectedVersion,
        },
      })
      handleClose()
    } catch (err: unknown) {
      const isStaleVersion =
        err && typeof err === "object" && "code" in err && err.code === "SCHEDULED_MESSAGE_STALE_VERSION"
      if (isStaleVersion) {
        toast.error("This message was edited elsewhere — refreshing…")
        handleClose()
        return
      }
      const message = err instanceof Error ? err.message : "Could not save"
      setError(message)
    }
  }, [scheduled, sendAtDate, expectedVersion, isLocalRow, updateMutation, handleClose, collectEditorContent])

  /**
   * Send now. Persists the current editor content first (so unsaved edits
   * ship), then force-sends via `sendNow` — which claims the row regardless
   * of its scheduled time. Saving with a past `scheduled_for` already sends
   * atomically, so skip the second call when the update itself transitioned
   * the row to `sent`.
   */
  const handleSendNow = useCallback(async () => {
    if (!scheduled || !sendAtDate || expectedVersion === null) return
    if (isLocalRow) {
      toast.info("Scheduling… try again in a moment")
      return
    }
    try {
      const { contentJson: materialized, attachmentIds } = collectEditorContent()
      const saved = await updateMutation.mutateAsync({
        id: scheduled.id,
        input: { contentJson: materialized, scheduledFor: sendAtDate.toISOString(), attachmentIds, expectedVersion },
      })
      if (saved.status !== "sent") {
        await sendNowMutation.mutateAsync(scheduled.id)
      }
      handleClose()
    } catch (err: unknown) {
      const isStaleVersion =
        err && typeof err === "object" && "code" in err && err.code === "SCHEDULED_MESSAGE_STALE_VERSION"
      if (isStaleVersion) {
        toast.error("This message was edited elsewhere — refreshing…")
        handleClose()
        return
      }
      const message = err instanceof Error ? err.message : "Could not send"
      setError(message)
    }
  }, [
    scheduled,
    sendAtDate,
    expectedVersion,
    isLocalRow,
    updateMutation,
    sendNowMutation,
    handleClose,
    collectEditorContent,
  ])

  const handleDelete = useCallback(async () => {
    if (!scheduled) return
    try {
      await cancelMutation.mutateAsync(scheduled.id)
    } catch (err: unknown) {
      // Non-local rows enqueue a retry inside the mutation; surface anything
      // that still bubbles so the user isn't left guessing.
      const message = err instanceof Error ? err.message : "Could not delete"
      toast.error(message)
    }
    handleClose()
  }, [scheduled, cancelMutation, handleClose])

  const isSaving = updateMutation.isPending
  const busy = updateMutation.isPending || sendNowMutation.isPending || cancelMutation.isPending

  const description = (() => {
    if (isLocalRow) return "Saving to the server… you can edit once the schedule lands."
    if (isPast) return "Send time has passed — Save sends immediately with your edits."
    return null
  })()

  const deleteLabel = isFailed ? "Remove" : "Delete"
  const saveLabel = isPast ? "Send" : "Save"
  const title = isPast ? "Send scheduled message" : "Edit scheduled message"

  const editorElement = (
    <RichEditor
      ref={setRichEditorHandle}
      value={contentJson}
      onChange={setContentJson}
      onSubmit={handleSave}
      onFileUpload={attachmentsHook.uploadFile}
      imageCount={attachmentsHook.imageCount}
      placeholder="Edit message…"
      ariaLabel="Edit scheduled message"
      messageSendMode="cmdEnter"
      disabled={isSaving}
      autoFocus
      disableSelectionToolbar={disableSelectionToolbar}
      blurOnEscape
      scopeId={scheduled?.id}
      memoAnchorStreamId={scheduled?.streamId}
      streamContext={streamContext}
      staticToolbarOpen={!isMobile && formatOpen}
      belowToolbarContent={
        attachmentsHook.pendingAttachments.length > 0 ? (
          <div className="border-b border-border/50 p-3 [&>div]:mb-0">
            <PendingAttachments
              attachments={attachmentsHook.pendingAttachments}
              onRemove={attachmentsHook.removeAttachment}
              workspaceId={workspaceId}
            />
          </div>
        ) : null
      }
    />
  )

  const fileInput = (
    <input
      ref={attachmentsHook.fileInputRef}
      type="file"
      multiple
      className="hidden"
      onChange={attachmentsHook.handleFileSelect}
      disabled={isSaving}
    />
  )

  // Mobile: Drawer with the editor filling its body. Padding lives INSIDE
  // .tiptap so a tap anywhere on the visible editor area focuses it — no
  // dead zone between the visual edge and the contenteditable.
  const canSubmit = !isLocalRow && sendAtDate !== null
  const trailingActions = (
    <ScheduledEditActions
      isPending={isPending}
      canSubmit={canSubmit}
      busy={busy}
      isSaving={isSaving}
      saveLabel={saveLabel}
      deleteLabel={deleteLabel}
      onDelete={handleDelete}
      onSendNow={handleSendNow}
      onSave={handleSave}
    />
  )

  if (isMobile) {
    return (
      <Drawer
        open={open}
        onOpenChange={(next) => {
          if (!next) handleClose()
        }}
      >
        <DrawerContent className={mobileExpanded ? "!h-[100dvh] rounded-t-none" : "min-h-[75dvh] max-h-[85dvh]"}>
          <DrawerTitle className="sr-only">{title}</DrawerTitle>

          <div className="flex flex-col flex-1 min-h-0 px-4 pt-5 gap-4">
            <div>
              <p className="text-base font-semibold">{title}</p>
              {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
            </div>

            <DateTimeField
              date={sendDate}
              time={sendTime}
              onDateChange={setSendDate}
              onTimeChange={setSendTime}
              disabled={isSaving}
              density="compact"
            />

            {/* Editor wrapper — the .tiptap inside fills the wrapper via
                min-h-full and carries the typing padding. No border, no bg,
                no inner padding on the wrapper itself, so visual edges and
                the tap target line up exactly. */}
            <div
              data-inline-edit
              className="flex-1 min-h-0 overflow-y-auto rounded-modal border border-input bg-card focus-within:border-ring focus-within:ring-1 focus-within:ring-ring [&_.tiptap_p]:!leading-relaxed [&_.tiptap]:max-h-none [&_.tiptap]:min-h-full [&_.tiptap]:px-3 [&_.tiptap]:py-3"
            >
              {error ? <div className="p-3 text-sm text-destructive">{error}</div> : editorElement}
            </div>
          </div>

          {fileInput}

          <div
            className="px-4 pt-3 pb-[max(20px,env(safe-area-inset-bottom))]"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
          >
            <EditorActionBar
              editorHandle={editorRef.current}
              disabled={isSaving}
              formatOpen={formatOpen}
              onFormatOpenChange={setFormatOpen}
              mobileExpanded={mobileExpanded}
              onMobileExpandedChange={setMobileExpanded}
              showAttach
              onAttachClick={() => attachmentsHook.fileInputRef.current?.click()}
              showExpand={false}
              trailingContent={trailingActions}
            />
            {formatOpen && (
              <EditorToolbar
                editor={toolbarEditor}
                isVisible
                inline
                inlinePosition="below"
                linkPopoverOpen={linkPopoverOpen}
                onLinkPopoverOpenChange={setLinkPopoverOpen}
                showSpecialInputControls
              />
            )}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  // Desktop: centered Dialog. Editor area uses internal .tiptap padding so
  // a click anywhere within the visible editor focuses it.
  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent
        className="sm:max-w-lg"
        // Radix's default focus management races TipTap's `autofocus: "end"`:
        // Radix grabs the close-X on open while TipTap claims the editor, and
        // the bounce can swallow the user's first click on the date/time
        // inputs (especially on Chrome where `<input type="time">` requires a
        // clean focus pass to enter spinner-edit mode). preventDefault here
        // lets TipTap own initial focus uncontested; subsequent clicks then
        // route normally.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <DateTimeField
            date={sendDate}
            time={sendTime}
            onDateChange={setSendDate}
            onTimeChange={setSendTime}
            disabled={isSaving}
            density="compact"
          />

          <div
            data-inline-edit
            className="rounded-modal border border-input bg-card overflow-hidden focus-within:border-ring focus-within:ring-1 focus-within:ring-ring [&_.tiptap]:overflow-y-auto [&_.tiptap]:px-3 [&_.tiptap]:py-3 [&_.tiptap]:min-h-[14rem] [&_.tiptap]:max-h-[24rem]"
          >
            {error ? <div className="p-3 text-sm text-destructive">{error}</div> : editorElement}
            {fileInput}
            <div className="border-t border-border/50 px-3 py-2">
              <EditorActionBar
                editorHandle={editorRef.current}
                disabled={isSaving}
                formatOpen={formatOpen}
                onFormatOpenChange={setFormatOpen}
                showAttach
                onAttachClick={() => attachmentsHook.fileInputRef.current?.click()}
                showExpand={false}
                trailingContent={trailingActions}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface ScheduledEditActionsProps {
  /** Send now + Save show only for pending rows; failed rows get Delete alone. */
  isPending: boolean
  /** False for local placeholders or an empty send time — disables the writes. */
  canSubmit: boolean
  /** Any mutation in flight — disables the whole cluster. */
  busy: boolean
  isSaving: boolean
  saveLabel: string
  deleteLabel: string
  onDelete: () => void
  onSendNow: () => void
  onSave: () => void
}

/**
 * Footer action cluster for the scheduled-message edit dialog, shared by the
 * mobile drawer and desktop dialog. Delete (destructive, icon-only so the row
 * of buttons still fits a phone), then Send now, then the primary Save/Send.
 * `onPointerDown` preventDefault keeps focus on the editor so the mobile soft
 * keyboard doesn't tear down mid-tap.
 */
export function ScheduledEditActions({
  isPending,
  canSubmit,
  busy,
  isSaving,
  saveLabel,
  deleteLabel,
  onDelete,
  onSendNow,
  onSave,
}: ScheduledEditActionsProps) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
        onPointerDown={(e) => e.preventDefault()}
        onClick={onDelete}
        disabled={busy}
        title={deleteLabel}
        aria-label={deleteLabel}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      {isPending && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2.5 text-xs shrink-0"
            onPointerDown={(e) => e.preventDefault()}
            onClick={onSendNow}
            disabled={busy || !canSubmit}
          >
            <Send className="h-3.5 w-3.5 mr-1.5" />
            Send now
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 px-3 text-xs shrink-0"
            onPointerDown={(e) => e.preventDefault()}
            onClick={onSave}
            disabled={busy || !canSubmit}
          >
            {isSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {isSaving ? "Saving…" : saveLabel}
          </Button>
        </>
      )}
    </>
  )
}
