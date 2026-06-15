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
  /**
   * The encrypted stream the draft seals to — the root stream whose SSK wraps
   * the body (a thread passes its root). Set only for E2E streams. Drives both
   * client-side upload encryption and draft body sealing/decryption (Stage 4c).
   */
  e2eStreamId?: string | null
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

  /**
   * Persist the live editor content into the loaded draft row immediately
   * (bypassing the debounce, sealing it for E2E) — but only when it is non-empty,
   * so it never takes the empty→delete path. Used by stash/restore to preserve
   * unsaved keystrokes before the loaded draft is detached or swapped, without
   * risking deletion of a draft whose editor is still mid-hydration.
   */
  flushDraft: () => Promise<void>
  /**
   * Re-run the composer's init from whatever draft is now loaded for the scope.
   * Called after a stash/restore pointer move so the editor re-reads (and, for
   * E2E, re-decrypts) the newly-loaded draft instead of keeping the old one.
   */
  markNeedsRehydrate: () => void

  // Clear helpers
  clearDraft: () => Promise<void>
  /**
   * Clear the loaded draft because its message was sent (resolve-on-send): same
   * local teardown as `clearDraft`, but the backend removal is CAS-guarded so a
   * copy that drifted on another device survives as a stash entry. Send paths
   * use this; plain discards (stash, empty composer) use `clearDraft`.
   */
  resolveDraft: () => Promise<void>
  clearAttachments: () => void

  /**
   * Hydrate attachments from a snapshot (e.g. when restoring a stashed draft).
   * Pushes them into the pending-attachments list; the persistence effect
   * then writes them into the scope's loaded draft on next flush.
   */
  restoreAttachments: (
    attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>
  ) => void

  // Loading
  isLoaded: boolean
  /** An E2E draft whose sealed body is still being decrypted into the composer. */
  isDecrypting: boolean
  /** An E2E draft whose sealed body couldn't be decrypted (wrong recipient / garbled). */
  decryptFailed: boolean
}

export function useDraftComposer({
  workspaceId,
  draftKey,
  scopeId,
  initialContent = EMPTY_DOC,
  e2eStreamId,
}: UseDraftComposerOptions): DraftComposerState {
  // Draft message persistence
  const {
    isLoaded: isDraftLoaded,
    isDecrypting,
    decryptFailed,
    contentJson: savedDraft,
    attachments: savedAttachments,
    contextRefs: savedContextRefs = [] as DraftContextRef[],
    saveDraft,
    saveDraftDebounced,
    addAttachment: addDraftAttachment,
    removeAttachment: removeDraftAttachment,
    clearDraft,
    resolveDraft,
  } = useDraftMessage(workspaceId, draftKey, e2eStreamId)

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
  } = useAttachments(workspaceId, { e2eEnabled: !!e2eStreamId })

  // Local state
  const [content, setContent] = useState<JSONContent>(initialContent)
  const [isSending, setIsSending] = useState(false)
  const hasInitialized = useRef(false)
  // True once the user has touched the editor for the current draft. Gates the
  // late-hydrate effect below so it only ever fills an editor the user hasn't
  // engaged with — never overwriting typed content nor re-filling a draft the
  // user just cleared (whose `savedDraft` lags by a debounce tick). Reset on
  // scope change and on an explicit restore.
  const userEngagedRef = useRef(false)
  // Set by an explicit scope-change / stash-restore: the NEXT available loaded-draft
  // body must be applied even over transient content the init effect may have
  // re-filled from the previous draft during the swap (the in-place restore race).
  // Cleared once that body lands; still yields to `userEngagedRef`.
  const awaitingRehydrateRef = useRef(false)
  const prevScopeIdRef = useRef<string | null>(null)
  // Keeps attachment persistence suspended until the previous scope's uploaded
  // attachments are gone from React state.
  const suspendAttachmentPersistence = useRef(false)
  const staleAttachmentIdsRef = useRef<Set<string>>(new Set())
  const restoredAttachmentIdsRef = useRef<Set<string>>(new Set())
  // Latest pending attachments, read by the reset below without making it a
  // dependency (which would churn its identity every render).
  const pendingAttachmentsRef = useRef(pendingAttachments)
  pendingAttachmentsRef.current = pendingAttachments
  // Latest editor content, so `flushDraft` always persists what's on screen now
  // rather than a value captured in a stale closure.
  const contentRef = useRef(content)
  contentRef.current = content

  // Persist the live editor content into the loaded draft row immediately
  // (sealed for E2E), but ONLY when it is non-empty. A stash/restore can fire
  // while the editor is still mid-hydration (transiently empty) — taking the
  // empty→delete path then would silently destroy the loaded draft. An
  // intentional clear is handled by the debounced save, never here.
  const flushDraft = useCallback(async () => {
    if (hasDocContent(contentRef.current)) await saveDraft(contentRef.current)
  }, [saveDraft])

  // Blank the composer to an un-initialized state so the init effect below
  // re-hydrates it from whatever draft is now loaded for the scope. Used on both
  // a scope change and an explicit stash/restore — the latter is a pointer move
  // that swaps the loaded draft WITHIN the same scope, so the editor must re-read
  // from the newly-pointed draft (decrypting it on the way in for E2E) exactly as
  // it would after a scope change.
  const resetForReinit = useCallback(() => {
    hasInitialized.current = false
    userEngagedRef.current = false
    awaitingRehydrateRef.current = true
    suspendAttachmentPersistence.current = true
    staleAttachmentIdsRef.current = new Set(
      pendingAttachmentsRef.current.filter((a) => a.status === "uploaded" && !a.id.startsWith("temp_")).map((a) => a.id)
    )
    restoredAttachmentIdsRef.current = new Set()
    setContent(initialContent)
    clearAttachments()
  }, [clearAttachments, initialContent])

  // Initialize content and attachments from saved draft, reset on scope change
  useEffect(() => {
    const isScopeChange = prevScopeIdRef.current !== null && prevScopeIdRef.current !== scopeId

    // On scope change, reset state
    if (isScopeChange) {
      resetForReinit()
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
  }, [scopeId, isDraftLoaded, savedDraft, savedAttachments, restoreAttachments, resetForReinit])

  // Late hydrate: the loaded draft's body can become available AFTER the one-shot
  // init above already ran — an E2E draft that was locked or still decrypting at
  // mount (unlock/decrypt lands later), or a stash/restore pointer move that
  // swaps in a different draft whose body decrypts on a later tick. When that
  // body lands and the user hasn't engaged with the editor, drop it in.
  //
  // Crucially this is NOT gated on `hasInitialized`: `markNeedsRehydrate` clears
  // it on a restore, and the restored body may only resolve across a pending
  // decrypt — so the apply has to survive that window. `userEngagedRef` is the
  // real guard: it flips true on the first keystroke, so this never overwrites
  // typed content nor re-fills a draft the user just cleared (whose `savedDraft`
  // lags by a debounce tick).
  //
  // Apply when EITHER the editor is empty (unlock/late decrypt into an untouched
  // editor) OR an explicit rehydrate is pending (scope change / stash-restore) —
  // the latter overrides transient content the init effect may have re-filled
  // from the OUTGOING draft before the pointer swap propagated (the in-place
  // restore race). The override fires once, then clears.
  useEffect(() => {
    if (!isDraftLoaded) return
    if (userEngagedRef.current) return
    if (!hasDocContent(savedDraft)) return
    if (!awaitingRehydrateRef.current && hasDocContent(content)) return
    setContent(savedDraft)
    awaitingRehydrateRef.current = false
  }, [isDraftLoaded, savedDraft, content])

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
      // The user owns the editor from here on — suppress the late-hydrate effect.
      userEngagedRef.current = true
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

    // Flush / re-hydrate (used by stash + restore)
    flushDraft,
    markNeedsRehydrate: resetForReinit,

    // Clear helpers
    clearDraft,
    resolveDraft,
    clearAttachments,
    restoreAttachments,

    // Loading
    isLoaded: isDraftLoaded,
    isDecrypting,
    decryptFailed,
  }
}
