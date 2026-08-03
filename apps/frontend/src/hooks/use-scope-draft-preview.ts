import { useCallback, useSyncExternalStore } from "react"
import { liveQuery, type Subscription } from "dexie"
import { db, type CachedDraft } from "@/db"
import { draftInlineText } from "@/lib/drafts/decryption"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { parseBoardDraftKey, BOARD_DRAFT_SCOPE_PREFIX } from "@/lib/board/draft-keys"

export interface ScopeDraftPreview {
  draftId: string
  /** One-line plain text of the draft body; "" for an attachment-only draft. */
  preview: string
  attachmentCount: number
  /**
   * True when the row is checked out into this device's composer (the ambient
   * auto-save) — opening the composer hydrates it by itself. False for a
   * stashed or roamed row (the loaded pointer is device-local), where the
   * opener must restore the row explicitly for the advertised draft to appear.
   */
  isCheckedOut: boolean
}

export interface SubtopicDraftEntry extends ScopeDraftPreview {
  scope: string
  streamId: string
  messageId: string
}

function hasPayload(draft: CachedDraft): boolean {
  return draft.ciphertext != null || !isEmptyContent(draft.contentJson) || (draft.attachments?.length ?? 0) > 0
}

function toPreview(best: CachedDraft, loadedDraftId: string | null): ScopeDraftPreview {
  return {
    draftId: best.id,
    preview: draftInlineText(best.contentJson),
    attachmentCount: best.attachments?.length ?? 0,
    isCheckedOut: best.id === loadedDraftId,
  }
}

/** The checked-out row when there is one, else the newest — what a resting
 *  affordance should advertise. */
function bestRow(rows: CachedDraft[], loadedDraftId: string | null): CachedDraft | null {
  const withPayload = rows.filter(hasPayload)
  if (withPayload.length === 0) return null
  return (
    withPayload.find((row) => row.id === loadedDraftId) ??
    withPayload.reduce((a, b) => (b.clientUpdatedAt > a.clientUpdatedAt ? b : a))
  )
}

interface BoardDraftsSnapshot {
  previewByScope: Map<string, ScopeDraftPreview>
  subtopicByMessageId: Map<string, SubtopicDraftEntry>
}

const EMPTY_SNAPSHOT: BoardDraftsSnapshot = {
  previewByScope: new Map(),
  subtopicByMessageId: new Map(),
}

interface BoardDraftsEntry {
  snapshot: BoardDraftsSnapshot
  /** False until the first IDB read emits — the board's reveal gate holds first
   *  paint on it so draft pills are present from the very first frame. */
  resolved: boolean
  listeners: Set<() => void>
  subscription: Subscription
  refCount: number
}

function buildSnapshot(rows: CachedDraft[], loadedByScope: Map<string, string | null>): BoardDraftsSnapshot {
  const byScope = new Map<string, CachedDraft[]>()
  for (const row of rows) {
    const list = byScope.get(row.scope)
    if (list) list.push(row)
    else byScope.set(row.scope, [row])
  }
  const previewByScope = new Map<string, ScopeDraftPreview>()
  const subtopicByMessageId = new Map<string, SubtopicDraftEntry>()
  for (const [scope, scopeRows] of byScope) {
    const loadedDraftId = loadedByScope.get(scope) ?? null
    const best = bestRow(scopeRows, loadedDraftId)
    if (!best) continue
    const preview = toPreview(best, loadedDraftId)
    previewByScope.set(scope, preview)
    const parsed = parseBoardDraftKey(scope)
    if (parsed?.kind === "subtopic") {
      subtopicByMessageId.set(parsed.messageId, {
        ...preview,
        scope,
        streamId: parsed.streamId,
        messageId: parsed.messageId,
      })
    }
  }
  return { previewByScope, subtopicByMessageId }
}

// INV-9 exception: one shared board-drafts liveQuery per workspace, ref-counted
// across every resting affordance that advertises a draft (card reply buttons,
// branch-tail pills, sub-topic indicators). Per-affordance queries can never
// have data at first paint — Dexie's first emission is always post-mount — so
// the pills popped in a frame after the board revealed, shifting layout. The
// registry resolves ONCE per workspace, the board's reveal gate waits on it
// (`useBoardDraftsReady`), and every hook below reads the settled snapshot
// synchronously. Mirrors `railRegistry` / `graphRegistry`.
const boardDraftsRegistry = new Map<string, BoardDraftsEntry>()

function subscribeBoardDrafts(workspaceId: string, listener: () => void): () => void {
  let entry = boardDraftsRegistry.get(workspaceId)
  if (!entry) {
    const created: BoardDraftsEntry = {
      snapshot: EMPTY_SNAPSHOT,
      resolved: false,
      listeners: new Set(),
      refCount: 0,
      subscription: { unsubscribe() {} } as Subscription,
    }
    // Register BEFORE subscribing so `getSnapshot` observes the entry consistently;
    // the callback re-reads the live entry so a late emission after teardown no-ops.
    boardDraftsRegistry.set(workspaceId, created)
    created.subscription = liveQuery(async () => {
      // The workspace's pointers are read as a whole (workspaceId index) rather
      // than bulkGet on the scopes with rows, so a pointer-only change (a stash
      // detaching the loaded pointer) re-fires the query too.
      const [rows, pointers] = await Promise.all([
        db.drafts
          .where("[workspaceId+scope]")
          .between([workspaceId, BOARD_DRAFT_SCOPE_PREFIX], [workspaceId, BOARD_DRAFT_SCOPE_PREFIX + "\uffff"])
          .toArray(),
        db.composerLoaded.where("workspaceId").equals(workspaceId).toArray(),
      ])
      return { rows, pointers }
    }).subscribe(({ rows, pointers }) => {
      const live = boardDraftsRegistry.get(workspaceId)
      if (!live) return
      const loadedByScope = new Map(pointers.map((p) => [p.scope, p.draftId]))
      live.snapshot = buildSnapshot(rows, loadedByScope)
      live.resolved = true
      for (const notify of live.listeners) notify()
    })
    entry = created
  }
  entry.listeners.add(listener)
  entry.refCount += 1
  return () => {
    const current = boardDraftsRegistry.get(workspaceId)
    if (!current) return
    current.listeners.delete(listener)
    current.refCount -= 1
    if (current.refCount <= 0) {
      current.subscription.unsubscribe()
      boardDraftsRegistry.delete(workspaceId)
    }
  }
}

function useBoardDraftsSubscription(workspaceId: string) {
  return useCallback((onChange: () => void) => subscribeBoardDrafts(workspaceId, onChange), [workspaceId])
}

/**
 * The draft a collapsed composer affordance for `scope` should advertise —
 * the same "your unsent text, one line" presentation the mobile composer's
 * collapsed bar uses. Read synchronously off the shared workspace snapshot,
 * so an affordance mounting after the board's reveal has its pill in its very
 * first frame. Null when the scope holds nothing worth showing.
 *
 * Board scopes only (`board:*`) — the registry's query is bounded to that
 * prefix, so any other scope would silently read null (INV-11: fail loudly).
 */
export function useScopeDraftPreview(workspaceId: string, scope: string): ScopeDraftPreview | null {
  if (!scope.startsWith(BOARD_DRAFT_SCOPE_PREFIX)) {
    throw new Error(`useScopeDraftPreview only serves board draft scopes (board:*); got "${scope}"`)
  }
  const subscribe = useBoardDraftsSubscription(workspaceId)
  const getSnapshot = useCallback(
    () => boardDraftsRegistry.get(workspaceId)?.snapshot.previewByScope.get(scope) ?? null,
    [workspaceId, scope]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Every board draft in the workspace keyed by scope — for a surface that must
 * test MANY scopes at once (a collapsed branch rolling its whole subtree up),
 * where one {@link useScopeDraftPreview} per scope would be a hook in a loop.
 */
export function useBoardScopeDraftIndex(workspaceId: string): Map<string, ScopeDraftPreview> {
  const subscribe = useBoardDraftsSubscription(workspaceId)
  const getSnapshot = useCallback(
    () => boardDraftsRegistry.get(workspaceId)?.snapshot.previewByScope ?? EMPTY_SNAPSHOT.previewByScope,
    [workspaceId]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Every new-sub-topic draft in the workspace, keyed by its fork message id —
 * so a conversation surface can mark the message rows that carry an unsent
 * sub-topic draft while the gesture's composer is unmounted. Same shared
 * snapshot as {@link useScopeDraftPreview}.
 */
export function useBoardSubtopicDraftIndex(workspaceId: string): Map<string, SubtopicDraftEntry> {
  const subscribe = useBoardDraftsSubscription(workspaceId)
  const getSnapshot = useCallback(
    () => boardDraftsRegistry.get(workspaceId)?.snapshot.subtopicByMessageId ?? EMPTY_SNAPSHOT.subtopicByMessageId,
    [workspaceId]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Whether the shared board-drafts snapshot's first IDB read has landed. Part
 *  of the board's coordinated reveal: cards must not take their first paint
 *  before it, or every draft pill pops in a frame later and shifts the rows
 *  below it (the timeline's no-shift rule, Kris 2026-07-13). */
export function useBoardDraftsReady(workspaceId: string): boolean {
  const subscribe = useBoardDraftsSubscription(workspaceId)
  const getSnapshot = useCallback(() => boardDraftsRegistry.get(workspaceId)?.resolved ?? false, [workspaceId])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Tear down every shared board-drafts subscription — for tests, so a
 *  module-level registry can't leak a liveQuery (or a snapshot) across cases. */
export function __clearBoardDraftsRegistry(): void {
  for (const entry of boardDraftsRegistry.values()) entry.subscription.unsubscribe()
  boardDraftsRegistry.clear()
}
