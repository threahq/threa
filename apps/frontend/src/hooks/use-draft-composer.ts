import { useState, useCallback, useEffect, useRef, type ChangeEvent, type RefObject } from "react"
import { useDraftMessage } from "./use-draft-message"
import { useAttachments, type PendingAttachment, type UploadResult } from "./use-attachments"
import type { JSONContent } from "@threa/types"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import type { DraftContextRef } from "@/lib/context-bag/types"

export interface UseDraftComposerOptions {
  workspaceId: string
  draftKey: string
  /** ID used for detecting scope changes (streamId or parentMessageId) */
  scopeId: string
  /** Initial content (optional, for pre-filled content as JSON) */
  initialContent?: JSONContent
  /** When the destination stream is E2E, encrypt uploads client-side. */
  e2eEnabled?: boolean
}

/** Check if a document is empty (no actual text content) */
function hasDocContent(doc: JSONContent | undefined): boolean {
  if (!doc?.content) return false
  return doc.content.some((node) => {
    if (node.type === "paragraph") {
      return node.content && node.content.length > 0
    }
    return true // Non-paragraph nodes count as content
  })
}

export interface DraftComposerState {
  // Content
  content: JSONContent
  setContent: (content: JSONContent) => void
  handleContentChange: (newContent: JSONContent) => void

  // Attachments
  pendingAttachments: PendingAttachment[]
  getPendingAttachmentsSnapshot: () => PendingAttachment[]
  uploadedIds: string[]
  isUploading: boolean
  hasFailed: boolean
  fileInputRef: RefObject<HTMLInputElement | null>
  handleFileSelect: (e: ChangeEvent<HTMLInputElement>) => void
  handleRemoveAttachment: (id: string) => void
  /** Upload a file programmatically (for paste/drop) */
  uploadFile: (file: File) => Promise<UploadResult>
  /** Current count of images (for sequential naming) */
  imageCount: number

  /** Context refs attached to this draft (sidecar — populated by "Discuss with Ariadne"). */
  contextRefs: DraftContextRef[]

  // Submission
  canSend: boolean
  isSending: boolean
  setIsSending: (sending: boolean) => void

  // Clear helpers
  clearDraft: () => Promise<void>
  clearAttachments: () => void

  /**
   * Hydrate attachments from a snapshot (e.g. when restoring a stashed draft).
   * Pushes them into the pending-attachments list; the persistence effect
   * then writes them into the active DraftMessage on next flush.
   */
  restoreAttachments: (
    attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>
  ) => void

  // Loading
  isLoaded: boolean
}

export function useDraftComposer({
  workspaceId,
  draftKey,
  scopeId,
  initialContent = EMPTY_DOC,
  e2eEnabled,
}: UseDraftComposerOptions): DraftComposerState {
  // Draft message persistence
  const {
    isLoaded: isDraftLoaded,
    contentJson: savedDraft,
    attachments: savedAttachments,
    contextRefs: savedContextRefs = [] as DraftContextRef[],
    saveDraftDebounced,
    addAttachment: addDraftAttachment,
    removeAttachment: removeDraftAttachment,
    clearDraft,
  } = useDraftMessage(workspaceId, draftKey)

  // Attachment handling
  const {
    pendingAttachments,
    getPendingAttachmentsSnapshot,
    fileInputRef,
    handleFileSelect,
    uploadFile,
    removeAttachment,
    uploadedIds,
    isUploading,
    hasFailed,
    clear: clearAttachments,
    restore: restoreAttachments,
    imageCount,
  } = useAttachments(workspaceId, { e2eEnabled })

  // Local state
  const [content, setContent] = useState<JSONContent>(initialContent)
  const [isSending, setIsSending] = useState(false)
  const hasInitialized = useRef(false)
  const prevScopeIdRef = useRef<string | null>(null)
  // Keeps attachment persistence suspended until the previous scope's uploaded
  // attachments are gone from React state.
  const suspendAttachmentPersistence = useRef(false)
  const staleAttachmentIdsRef = useRef<Set<string>>(new Set())
  const restoredAttachmentIdsRef = useRef<Set<string>>(new Set())

  // Initialize content and attachments from saved draft, reset on scope change
  useEffect(() => {
    const isScopeChange = prevScopeIdRef.current !== null && prevScopeIdRef.current !== scopeId

    // On scope change, reset state
    if (isScopeChange) {
      hasInitialized.current = false
      suspendAttachmentPersistence.current = true
      staleAttachmentIdsRef.current = new Set(
        pendingAttachments.filter((a) => a.status === "uploaded" && !a.id.startsWith("temp_")).map((a) => a.id)
      )
      restoredAttachmentIdsRef.current = new Set()
      setContent(initialContent)
      clearAttachments()
    }

    // Track scope changes
    if (prevScopeIdRef.current !== scopeId) {
      prevScopeIdRef.current = scopeId
    }

    // Wait for Dexie to finish loading before initializing
    if (!isDraftLoaded) {
      return
    }

    // Restore saved draft content and attachments
    if (!hasInitialized.current) {
      if (hasDocContent(savedDraft)) {
        setContent(savedDraft)
      }
      if (savedAttachments.length > 0) {
        restoreAttachments(savedAttachments)
      }
      restoredAttachmentIdsRef.current = new Set(savedAttachments.map((attachment: { id: string }) => attachment.id))
      hasInitialized.current = true
    }
  }, [
    scopeId,
    isDraftLoaded,
    savedDraft,
    savedAttachments,
    restoreAttachments,
    clearAttachments,
    initialContent,
    pendingAttachments,
  ])

  // When attachments change, persist to draft storage
  useEffect(() => {
    const uploaded = pendingAttachments.filter((a) => a.status === "uploaded" && !a.id.startsWith("temp_"))

    // After a scope change, keep skipping persistence until we have stopped
    // seeing any uploaded attachments that belonged to the previous scope.
    if (suspendAttachmentPersistence.current) {
      const hasStaleAttachments = uploaded.some((attachment) => staleAttachmentIdsRef.current.has(attachment.id))
      if (!hasStaleAttachments && hasInitialized.current) {
        suspendAttachmentPersistence.current = false
      }
      if (suspendAttachmentPersistence.current) {
        return
      }
    }

    const uploadedToPersist = uploaded.filter((attachment) => !restoredAttachmentIdsRef.current.has(attachment.id))

    // Only update draft if we have uploaded attachments and we're past initialization
    if (hasInitialized.current && uploadedToPersist.length > 0) {
      // Sync each attachment to draft storage
      for (const a of uploadedToPersist) {
        addDraftAttachment({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
        })
      }
    }
  }, [pendingAttachments, addDraftAttachment])

  // Handle content change with draft persistence
  const handleContentChange = useCallback(
    (newContent: JSONContent) => {
      setContent(newContent)
      saveDraftDebounced(newContent)
    },
    [saveDraftDebounced]
  )

  // Handle attachment removal from both UI and draft storage
  const handleRemoveAttachment = useCallback(
    (id: string) => {
      removeAttachment(id)
      removeDraftAttachment(id)
    },
    [removeAttachment, removeDraftAttachment]
  )

  // Check if document has actual content (not just empty paragraphs)
  const hasContent =
    content.content?.some((node) => {
      if (node.type === "paragraph") {
        return node.content && node.content.length > 0
      }
      return true // Non-paragraph nodes count as content
    }) ?? false

  // Sending while uploads are still in flight is not safe: the message would
  // be created before attachment IDs exist, leaving uploaded files unattached.
  // Failed uploads still don't block send; the user can send with whatever succeeded.
  //
  // Context-ref sidecar follows the same model: a `pending` ref means
  // precompute is still in flight (sending now risks an inline-summarize
  // delay on the first turn), and `error` means the server couldn't resolve
  // the ref (we'd produce a turn without context). `ready` and `inline`
  // are safe.
  //
  // A context ref alone is enough to send: "Discuss with Ariadne" can be
  // dispatched with just the attached thread chip — no body text, no upload
  // required. Treating refs as a third payload type lets the user fire off
  // "what's going on here?" without typing.
  const contextRefsReady = savedContextRefs.every(
    (ref: DraftContextRef) => ref.status === "ready" || ref.status === "inline"
  )
  const hasPayload = hasContent || uploadedIds.length > 0 || savedContextRefs.length > 0
  const canSend = hasPayload && !isSending && !isUploading && contextRefsReady

  return {
    // Content
    content,
    setContent,
    handleContentChange,

    // Attachments
    pendingAttachments,
    getPendingAttachmentsSnapshot,
    uploadedIds,
    isUploading,
    hasFailed,
    fileInputRef,
    handleFileSelect,
    handleRemoveAttachment,
    uploadFile,
    imageCount,

    // Context refs (sidecar — populated by "Discuss with Ariadne")
    contextRefs: savedContextRefs,

    // Submission
    canSend,
    isSending,
    setIsSending,

    // Clear helpers
    clearDraft,
    clearAttachments,
    restoreAttachments,

    // Loading
    isLoaded: isDraftLoaded,
  }
}
