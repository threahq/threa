import { useState, useCallback, useEffect, useRef, useSyncExternalStore, type ChangeEvent, type RefObject } from "react"
import { useDraftMessage } from "./use-draft-message"
import { useAttachments, type PendingAttachment, type UploadResult } from "./use-attachments"
import type { JSONContent } from "@threa/types"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import type { DraftContextRef } from "@/lib/context-bag/types"
import { generateLocalDraftId, type CachedDraft, type DraftAttachment } from "@/db"
import { resolveMigratedDraftId, wasDraftResolvedLocally } from "@/sync/draft-resolution-guard"

// Mounted composers per draft scope, in mount order. More than one live composer
// on a scope is a precondition for the rescue below: with only this one, a
// vanishing loaded pointer is always this composer's own teardown. The order is
// what makes the `?stash=` claim single-valued — the first still-mounted composer
// on a scope owns the param, so a board card and a conversation panel on the same
// scope can't both restore it. Registry like `boardDraftsRegistry` in
// `use-scope-draft-preview.ts` (INV-9 exception: process-wide by construction).
const mountedComposersByScope = new Map<string, string[]>()
const composerRegistryListeners = new Set<() => void>()

function mountedComposerCount(key: string): number {
  return mountedComposersByScope.get(key)?.length ?? 0
}

function registerComposer(key: string, token: string): () => void {
  const tokens = mountedComposersByScope.get(key)
  if (tokens) tokens.push(token)
  else mountedComposersByScope.set(key, [token])
  for (const notify of composerRegistryListeners) notify()
  return () => {
    const live = mountedComposersByScope.get(key)
    if (!live) return
    const at = live.indexOf(token)
    if (at >= 0) live.splice(at, 1)
    if (live.length === 0) mountedComposersByScope.delete(key)
    for (const notify of composerRegistryListeners) notify()
  }
}

function subscribeComposerRegistry(listener: () => void): () => void {
  composerRegistryListeners.add(listener)
  return () => composerRegistryListeners.delete(listener)
}

/**
 * How many composers are mounted on a scope right now. A host that can point
 * itself at another scope needs this: two live editors on one draft row fight
 * over it — the second never re-reads an ordinary body change, so whichever
 * saves last wins and the other's text is gone.
 */
export function useMountedComposerCount(workspaceId: string, scope: string | null): number {
  const key = scope ? `${workspaceId} ${scope}` : ""
  return useSyncExternalStore(
    subscribeComposerRegistry,
    useCallback(() => (key ? mountedComposerCount(key) : 0), [key])
  )
}

// Cached per-workspace mounted-scope sets, rebuilt lazily after each registry
// change: `useSyncExternalStore` needs a STABLE snapshot reference between
// notifications or it loops.
const mountedScopeSetCache = new Map<string, ReadonlySet<string>>()
composerRegistryListeners.add(() => mountedScopeSetCache.clear())

/**
 * Every scope with a live composer mounted for `workspaceId`, as a set. The
 * stash pile uses it to route rows whose draft is ALREADY ON SCREEN in its own
 * composer (an open conversation panel's docked footer): tapping such a row
 * navigates/focuses there instead of adopting into a host whose yield-to-panel
 * effect would immediately undo the adopt.
 */
export function useMountedComposerScopes(workspaceId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeComposerRegistry,
    useCallback(() => {
      let set = mountedScopeSetCache.get(workspaceId)
      if (!set) {
        const prefix = `${workspaceId} `
        const built = new Set<string>()
        for (const key of mountedComposersByScope.keys()) {
          if (key.startsWith(prefix)) built.add(key.slice(prefix.length))
        }
        set = built
        mountedScopeSetCache.set(workspaceId, set)
      }
      return set
    }, [workspaceId])
  )
}

/**
 * Whether this composer is the one host that consumes a `?stash=` deep link for
 * its scope. Exactly one mounted composer per scope answers true; the rest defer,
 * leaving the param for the claimant rather than each restoring it.
 */
function useIsStashClaimant(scopeRegistryKey: string, token: string): boolean {
  return useSyncExternalStore(
    subscribeComposerRegistry,
    () => mountedComposersByScope.get(scopeRegistryKey)?.[0] === token
  )
}

let composerTokenSeq = 0

/** Uploaded (non-temp, non-failed) attachments in the shape the draft row stores. */
function persistableAttachments(pending: PendingAttachment[]): DraftAttachment[] {
  return pending
    .filter((a) => a.status !== "error" && !a.id.startsWith("temp_"))
    .map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes }))
}

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
export function hasDocContent(doc: JSONContent | undefined): boolean {
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
  /** Abort an in-flight upload and drop its chip (the × during upload). */
  handleCancelAttachmentUpload: (id: string) => void
  /** Upload a file programmatically (for paste/drop) */
  uploadFile: (file: File) => Promise<UploadResult>
  /** Current count of images (for sequential naming) */
  imageCount: number

  /** Context refs attached to this draft (sidecar — a context bag rides beside the body). */
  contextRefs: DraftContextRef[]

  // Submission
  canSend: boolean
  isSending: boolean
  setIsSending: (sending: boolean) => void

  /**
   * Persist the live editor payload immediately, bypassing the debounce. Normal
   * stash/restore calls avoid the empty→delete path; filing-only scope moves may
   * preserve an existing row after the user deliberately cleared its body.
   */
  flushDraft: (options?: { keepEmpty?: boolean; contentJson?: JSONContent }) => Promise<void>
  /** Same flush, reporting false when a payload was present but could not be persisted. */
  flushDraftWithResult: (options?: { keepEmpty?: boolean; contentJson?: JSONContent }) => Promise<boolean>
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
   * Take over already-uploaded attachments from another draft (a hand-off):
   * held by this composer and persisted onto this draft's row, bytes untouched.
   */
  adoptAttachments: (attachments: DraftAttachment[]) => void
  /**
   * Let go of this draft's uploaded attachments without deleting the uploads —
   * the other half of a hand-off, once another draft has adopted them. The
   * chips leave and the row forgets them; the files stay.
   */
  releaseAttachments: () => void

  // Loading
  isLoaded: boolean
  /** An E2E draft whose sealed body is still being decrypted into the composer. */
  isDecrypting: boolean
  /** An E2E draft whose sealed body couldn't be decrypted (wrong recipient / garbled). */
  decryptFailed: boolean
  /**
   * True for the single host that consumes a `?stash=<id>` deep link for this
   * scope. Several composers can mount one scope (a board card and the
   * conversation panel's footer are the standing case) — only the first one
   * mounted restores the deep-linked row.
   */
  isStashClaimant: boolean
}

export function useDraftComposer({
  workspaceId,
  draftKey,
  scopeId,
  initialContent = EMPTY_DOC,
  e2eStreamId,
}: UseDraftComposerOptions): DraftComposerState {
  // Which draft row the editor's current content came from (hydrated, or created
  // by the first save). Every save path addresses THIS row instead of re-reading
  // the scope's pointer, so a repoint between hydration and a debounced save can
  // never write this content into the newly-pointed draft. Set wherever the
  // content is (re)filled from a loaded draft below; advanced by `useDraftMessage`
  // itself after a create.
  const contentDraftIdRef = useRef<string | null>(null)

  // Draft message persistence
  const {
    isLoaded: isDraftLoaded,
    isDecrypting,
    decryptFailed,
    loadedDraftId,
    contentDraftScope,
    contentJson: savedDraft,
    attachments: savedAttachments,
    contextRefs: savedContextRefs = [] as DraftContextRef[],
    saveDraft,
    saveDraftDebounced,
    cancelPendingSave,
    addAttachment: addDraftAttachment,
    removeAttachment: removeDraftAttachment,
    clearDraft,
    resolveDraft,
  } = useDraftMessage(workspaceId, draftKey, e2eStreamId, contentDraftIdRef)

  // Attachment handling
  const {
    pendingAttachments,
    getPendingAttachmentsSnapshot,
    fileInputRef,
    handleFileSelect,
    uploadFile,
    removeAttachment,
    cancelUpload,
    uploadedIds,
    isUploading,
    isReserving,
    hasFailed,
    clear: clearAttachments,
    restore: restoreAttachments,
    imageCount,
  } = useAttachments(workspaceId, { e2eEnabled: !!e2eStreamId })

  // Local state
  const [content, setContent] = useState<JSONContent>(initialContent)
  const [isSending, setIsSending] = useState(false)
  const hasInitialized = useRef(false)
  // True once the user has touched the editor for the current draft. Gates BOTH
  // the one-shot init fill and the late-hydrate effect below so they only ever
  // fill an editor the user hasn't engaged with — never overwriting typed content
  // nor re-filling a draft the user just cleared (whose `savedDraft` lags by a
  // debounce tick). Reset on scope change and on an explicit restore.
  const userEngagedRef = useRef(false)
  // Set by an explicit scope-change / stash-restore: the NEXT available loaded-draft
  // body must be applied even over transient content the init effect may have
  // re-filled from the previous draft during the swap (the in-place restore race).
  // Cleared once that body lands; still yields to `userEngagedRef`.
  const awaitingRehydrateRef = useRef(false)
  // Tracks whether the loaded draft's body was available last render, so the
  // late-hydrate fires only on the RISING edge (a body arriving into an empty
  // editor — unlock/decrypt), never on a falling edge (a send/clear emptying it).
  const prevSavedAvailableRef = useRef(false)
  // Tracks the loaded draft id so the composer can blank the editor the moment the
  // draft is removed underneath it (sent/resolved here, or discarded/resolved on
  // another device — id → null), instead of leaving a gone draft on screen.
  const prevLoadedIdRef = useRef<string | null>(null)
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
  // Latest decrypted attachments, read by the late-hydrate effect without making
  // them a dependency: `savedAttachments` is a fresh array each render (it maps
  // decrypted refs), so depending on it would re-run the body late-hydrate every
  // render and misfire its rising-edge tracking.
  const savedAttachmentsRef = useRef(savedAttachments)
  savedAttachmentsRef.current = savedAttachments

  const scopeRegistryKey = `${workspaceId} ${draftKey}`
  const composerTokenRef = useRef<string | null>(null)
  if (composerTokenRef.current === null) composerTokenRef.current = `composer_${++composerTokenSeq}`
  const composerToken = composerTokenRef.current
  useEffect(() => registerComposer(scopeRegistryKey, composerToken), [scopeRegistryKey, composerToken])
  const isStashClaimant = useIsStashClaimant(scopeRegistryKey, composerToken)

  // Persist the live editor content into the loaded draft row immediately
  // (sealed for E2E), but ONLY when it is non-empty. A stash/restore can fire
  // while the editor is still mid-hydration (transiently empty) — taking the
  // empty→delete path then would silently destroy the loaded draft. An
  // intentional clear is handled by the debounced save, never here.
  const flushDraftWithResult = useCallback(
    async (options?: { keepEmpty?: boolean; contentJson?: JSONContent }) => {
      const contentJson = options?.contentJson ?? contentRef.current
      const attachments = persistableAttachments(getPendingAttachmentsSnapshot())
      if (options?.keepEmpty) {
        return (await saveDraft(contentJson, attachments, undefined, { keepEmpty: true })) !== null
      }
      if (hasDocContent(contentJson)) return (await saveDraft(contentJson)) !== null
      if (attachments.length > 0) return (await saveDraft(contentJson, attachments)) !== null
      return true
    },
    [getPendingAttachmentsSnapshot, saveDraft]
  )
  const flushDraft = useCallback(
    async (options?: { keepEmpty?: boolean; contentJson?: JSONContent }) => {
      await flushDraftWithResult(options)
    },
    [flushDraftWithResult]
  )

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

    const followsSameDraft = loadedDraftId !== null && contentDraftIdRef.current === loadedDraftId
    if (isScopeChange && !followsSameDraft) resetForReinit()

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
      // This one-shot init can be DEFERRED past the user's first keystroke: an E2E
      // body only becomes readable once its decrypt lands (`isDraftLoaded` gates
      // this effect off until then), so a fast typist may already own the editor by
      // the time it finally runs. Filling content the user has engaged with would
      // overwrite their keystrokes with the stale loaded body — a focused composer
      // is never overwritten by anything but the user's own typing. Same guard the
      // late-hydrate effect below uses.
      if (hasDocContent(savedDraft) && !userEngagedRef.current) {
        setContent(savedDraft)
      }
      if (savedAttachments.length > 0) {
        restoreAttachments(savedAttachments)
      }
      restoredAttachmentIdsRef.current = new Set(savedAttachments.map((attachment: { id: string }) => attachment.id))
      contentDraftIdRef.current = loadedDraftId ?? null
      hasInitialized.current = true
    }
  }, [scopeId, isDraftLoaded, savedDraft, savedAttachments, restoreAttachments, resetForReinit, loadedDraftId])

  // Restore the loaded draft's (decrypted) attachments alongside its body when the
  // body late-hydrates. A sealed E2E draft's attachments become readable only once
  // it decrypts (Stage 4d), so the unlock-after-open path that re-fills the body
  // must re-fill the attachment chips too — they decrypt together. A no-op when
  // there are none, so a body-only draft never clears an in-flight upload. Marks
  // them restored so the persistence effect doesn't re-seal what we just read back.
  const hydrateAttachments = useCallback(() => {
    const attachments = savedAttachmentsRef.current
    if (attachments.length === 0) return
    restoredAttachmentIdsRef.current = new Set(attachments.map((a) => a.id))
    restoreAttachments(attachments)
  }, [restoreAttachments])

  // Late hydrate: the loaded draft's body/attachments can become available AFTER
  // the one-shot init above already ran — an E2E draft that was locked or still
  // decrypting at mount (unlock/decrypt lands later), or a stash/restore pointer
  // move that swaps in a different draft whose body decrypts on a later tick. When
  // it lands and the user hasn't engaged with the editor, drop it in.
  //
  // `userEngagedRef` is the real guard: it flips true on the first keystroke, so
  // this never overwrites typed content. The two apply paths are deliberately
  // narrow so a SEND/clear (which empties the editor) can't trigger a re-fill:
  //  - explicit rehydrate (scope change / stash-restore): override transient
  //    content once, even across a pending decrypt (`awaitingRehydrateRef`).
  //  - unlock/late-decrypt: apply only on the RISING edge of availability (body or
  //    attachments just became available) into a still-empty editor. A send clears
  //    the editor AND empties the decrypted attachments, so that's a falling edge /
  //    no edge and it never re-fills the just-sent content.
  //
  // Availability tracks body OR attachments so an attachment-only sealed draft
  // (empty body, files attached) hydrates its chips on unlock too; `setContent` is
  // still gated on the body being present so an empty body never blanks the editor.
  // A stable key over the loaded draft's attachment ids: it only changes when the
  // set does, so it can drive the effect below (the `savedAttachments` array itself
  // is a fresh identity every render and would re-run it constantly). This is what
  // lets an attachment-only sealed draft — whose body never changes from empty —
  // re-run the effect when its attachments decrypt in.
  const savedAttachmentIds = savedAttachments.map((a) => a.id).join(",")
  useEffect(() => {
    const savedBodyAvailable = hasDocContent(savedDraft)
    const savedAvailable = savedBodyAvailable || savedAttachmentsRef.current.length > 0
    const becameAvailable = savedAvailable && !prevSavedAvailableRef.current
    prevSavedAvailableRef.current = savedAvailable
    if (!isDraftLoaded || userEngagedRef.current || !savedAvailable) return
    if (awaitingRehydrateRef.current) {
      if (savedBodyAvailable) setContent(savedDraft)
      hydrateAttachments()
      contentDraftIdRef.current = loadedDraftId ?? null
      awaitingRehydrateRef.current = false
      return
    }
    if (becameAvailable && !hasDocContent(content)) {
      if (savedBodyAvailable) setContent(savedDraft)
      hydrateAttachments()
      contentDraftIdRef.current = loadedDraftId ?? null
    }
  }, [isDraftLoaded, savedDraft, savedAttachmentIds, content, hydrateAttachments, loadedDraftId])

  // Blank the editor the moment the loaded draft is removed underneath the
  // composer: sent/resolved here, or discarded/resolved on another device (its
  // `draft:deleted` clears this scope's pointer). Without this the just-sent or
  // remotely-cleared body lingers on screen.
  //
  // But NOT while the user is actively editing non-empty content. A genuine
  // removal of a draft with unpushed edits MIGRATES those edits to a new id (the
  // loaded id changes value rather than going null — see `applyDraftDeleted`), so
  // a null arriving WHILE the editor holds engaged keystrokes is a transient
  // re-read flicker of the loaded pointer, not a real removal. Blanking on it
  // wiped the in-progress edits and, on the pointer's return, the late-hydrate
  // rising edge re-filled the stale last-saved body — the keystrokes were lost.
  // A clean (unedited) loaded draft still clears: that is the cross-device case.
  //
  // A pointer that changes VALUE (X → Y) is a repoint: another surface — or a
  // restore — checked a different draft into this scope. The editor is still
  // rendering X, so persist X's content to X's own row (identity-addressed, so it
  // cannot cross-write into Y) and then re-run init against Y. Rehydration happens
  // whether or not the user is engaged: the repoint is this same user's own action
  // on this device, so the new draft is what they asked to see.
  // Serialization (why and how) is documented once, on the chain effect below.
  //
  // NOT async: a transition with no persistence work completes synchronously
  // (returns null) so its resets and ref updates land in the same tick the
  // pointer changed — the pre-chain semantics every hydrate effect depends on.
  // Only the flush leg returns a promise, and only THAT marks the chain busy.
  const handlePointerTransition = useCallback(
    (prev: string | null, next: string | null): Promise<void> | null => {
      if (!next) {
        if (!prev) return null
        // The row can move scopes before its host target catches up. The mounted
        // editor still owns this identity, so the old pointer going null is not
        // a removal.
        if (contentDraftScope && contentDraftScope !== draftKey) return null
        if (userEngagedRef.current && hasDocContent(contentRef.current)) {
          // With another composer live on this scope, the vanishing pointer can be
          // THAT editor's send resolving the shared row while this one holds newer
          // unsent text that exists only in React state — persist it rather than
          // merely declining to blank. Both conditions are load-bearing: alone on
          // the scope the null is a deliberate teardown (stash/clear/purge), and
          // only a local resolve-on-send marks the id, so a remote
          // `draft:deleted` reads false and stays deleted instead of being
          // resurrected by whichever device happens to hold the composer open.
          if (mountedComposerCount(scopeRegistryKey) > 1 && wasDraftResolvedLocally(prev)) {
            // The rescued text belongs to a row that was just RESOLVED (deleted
            // on send) — an identity-addressed save for it would be dropped by
            // the no-resurrection rule. Clearing the identity first makes this a
            // plain create under the now-empty scope: a sanctioned new row for
            // genuinely newer text, not a resurrection of the sent one.
            contentDraftIdRef.current = null
            return saveDraft(contentRef.current, persistableAttachments(getPendingAttachmentsSnapshot())).then(
              () => undefined,
              (err) => {
                console.error("Failed to persist draft rescued from a resolved row", err)
              }
            )
          }
          return null
        }
        userEngagedRef.current = false
        contentDraftIdRef.current = null
        setContent(initialContent)
        clearAttachments()
        return null
      }
      // The pointer flickered away and back to the row the editor's content
      // already belongs to — nothing to reconcile.
      if (contentDraftIdRef.current === next) return null
      if (prev && resolveMigratedDraftId(prev) === next) {
        // Not a repoint: the SAME draft was re-keyed underneath the composer (a
        // split ack / remote-delete preserve). The editor's content still belongs
        // to this row, so nothing is flushed and nothing is reset — the id is
        // simply followed. Any armed save captured the old id and is redirected
        // by the migration map on the write path.
        contentDraftIdRef.current = next
        return null
      }
      if (!userEngagedRef.current) {
        // Idle. A first pointer (null → X) adopts and lets init/late-hydrate
        // fill; a repoint re-runs init against the new draft.
        if (prev) resetForReinit()
        contentDraftIdRef.current = next
        return null
      }
      if (!hasDocContent(contentRef.current)) {
        // Engaged but empty (typed, then deleted back to nothing). Nothing to
        // preserve, but the debounce may still be armed with an EMPTY_DOC save —
        // fired later it would delete whatever row it resolves to. Drop it
        // without persisting, then hydrate from the arriving draft.
        cancelPendingSave()
        resetForReinit()
        contentDraftIdRef.current = next
        return null
      }
      // Engaged with content. If the content belongs to a row (an ordinary
      // repoint), flush it there; if it has no identity — typing that outran
      // hydration, or a fragment kept on screen by an earlier gated save — it
      // must NOT touch any existing row, so it detaches into its own fresh one
      // (a never-existing expected id takes the create path without stealing
      // the pointer). Only once the save actually persisted may the editor be
      // blanked: on a locked E2E scope it returns null, and resetting would
      // erase the content from screen and disk both, so the focused composer
      // keeps it (and its identity) until it can be saved.
      const owner = contentDraftIdRef.current
      return saveDraft(
        contentRef.current,
        persistableAttachments(getPendingAttachmentsSnapshot()),
        owner ?? generateLocalDraftId()
      ).then(
        (saved: CachedDraft | null) => {
          if (!saved) return
          resetForReinit()
          contentDraftIdRef.current = next
        },
        (err) => {
          console.error("Failed to persist draft content displaced by a repoint", err)
        }
      )
    },
    [
      saveDraft,
      cancelPendingSave,
      resetForReinit,
      initialContent,
      clearAttachments,
      scopeRegistryKey,
      getPendingAttachmentsSnapshot,
      contentDraftScope,
      draftKey,
    ]
  )

  // Transitions are handled STRICTLY IN ORDER: a transition whose handler
  // persists content (returns a promise) marks the chain busy, and any
  // transition arriving before it settles queues behind it — a second repoint
  // landing inside the save's in-flight window (a programmatic double-restore,
  // a catch-up burst) must not read half-updated refs and flush the wrong
  // content into the wrong row. `prevLoadedIdRef` advances synchronously so
  // each queued handler gets its own (prev, next) pair; everything else is read
  // at run time, after the previous handler settled.
  const pointerTransitionTailRef = useRef<Promise<void> | null>(null)
  useEffect(() => {
    const prev = prevLoadedIdRef.current
    const next = loadedDraftId ?? null
    prevLoadedIdRef.current = next
    if (prev === next) return
    const pending = pointerTransitionTailRef.current
    if (!pending) {
      const run = handlePointerTransition(prev, next)
      if (!run) return
      const tail: Promise<void> = run.then(() => {
        if (pointerTransitionTailRef.current === tail) pointerTransitionTailRef.current = null
      })
      pointerTransitionTailRef.current = tail
      return
    }
    const tail: Promise<void> = pending
      .then(() => handlePointerTransition(prev, next) ?? undefined)
      .then(() => {
        if (pointerTransitionTailRef.current === tail) pointerTransitionTailRef.current = null
      })
    pointerTransitionTailRef.current = tail
  }, [loadedDraftId, handlePointerTransition])

  // When attachments change, persist to draft storage. Reserved-but-still-
  // uploading attachments persist too: their id is already real, and a draft
  // restore after a reload re-claims the resumed upload job by that id.
  useEffect(() => {
    const uploaded = persistableAttachments(pendingAttachments)

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
        addDraftAttachment(a)
      }
    }
  }, [pendingAttachments, addDraftAttachment])

  // Handle content change with draft persistence
  const handleContentChange = useCallback(
    (newContent: JSONContent) => {
      // The user owns the editor from here on — suppress the init/late-hydrate
      // fills, and cancel any pending rehydrate: a restore/scope-change body that
      // hasn't landed yet is now moot, since the user's keystrokes supersede it.
      userEngagedRef.current = true
      awaitingRehydrateRef.current = false
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

  const adoptAttachments = useCallback(
    (attachments: DraftAttachment[]) => {
      if (attachments.length === 0) return
      // Marked restored so the persistence effect doesn't add them a second
      // time; the one explicit add below is what writes them onto the row.
      for (const attachment of attachments) restoredAttachmentIdsRef.current.add(attachment.id)
      restoreAttachments(attachments)
      for (const attachment of attachments) addDraftAttachment(attachment)
    },
    [restoreAttachments, addDraftAttachment]
  )

  const releaseAttachments = useCallback(() => {
    const held = pendingAttachmentsRef.current.filter((attachment) => attachment.status === "uploaded")
    clearAttachments()
    for (const attachment of held) removeDraftAttachment(attachment.id)
  }, [clearAttachments, removeDraftAttachment])

  // Cancel an in-flight upload: abort the transfer, drop the chip, delete the
  // reservation — and remove it from the persisted draft so a rehydrate
  // doesn't resurrect a file the user just abandoned.
  const handleCancelAttachmentUpload = useCallback(
    (id: string) => {
      cancelUpload(id)
      removeDraftAttachment(id)
    },
    [cancelUpload, removeDraftAttachment]
  )

  // Check if document has actual content (not just empty paragraphs)
  const hasContent = hasDocContent(content)

  // Send no longer waits for uploads: reserved ids bind to the message and the
  // bytes finish in the background (send-while-uploading). The ONLY upload
  // phase that gates send is the sub-second reservation window — an id-less
  // file would be silently dropped from the message.
  // Failed uploads still don't block send; the user can send with whatever succeeded.
  //
  // Context-ref sidecar follows the same model: a `pending` ref means
  // precompute is still in flight (sending now risks an inline-summarize
  // delay on the first turn), and `error` means the server couldn't resolve
  // the ref (we'd produce a turn without context). `ready` and `inline`
  // are safe.
  //
  // A context ref alone is enough to send: a context-seeded draft can be
  // dispatched with just the attached thread chip — no body text, no upload
  // required. Treating refs as a third payload type lets the user fire off
  // "what's going on here?" without typing.
  const contextRefsReady = savedContextRefs.every(
    (ref: DraftContextRef) => ref.status === "ready" || ref.status === "inline"
  )
  const hasPayload = hasContent || uploadedIds.length > 0 || savedContextRefs.length > 0
  const canSend = hasPayload && !isSending && !isReserving && contextRefsReady

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
    handleCancelAttachmentUpload,
    uploadFile,
    imageCount,

    // Context refs (sidecar — a context bag rides beside the body)
    contextRefs: savedContextRefs,

    // Submission
    canSend,
    isSending,
    setIsSending,

    // Flush / re-hydrate (used by stash + restore)
    flushDraft,
    flushDraftWithResult,
    markNeedsRehydrate: resetForReinit,

    // Clear helpers
    clearDraft,
    resolveDraft,
    clearAttachments,
    adoptAttachments,
    releaseAttachments,

    // Loading
    isLoaded: isDraftLoaded,
    isDecrypting,
    decryptFailed,
    isStashClaimant,
  }
}
