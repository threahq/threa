import { useCallback, useSyncExternalStore } from "react"
import { liveQuery, type Subscription } from "dexie"
import { db, type CachedDraft } from "@/db"
import { collapsedComposerPreview } from "@/lib/drafts/collapsed-composer-preview"
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
    preview: collapsedComposerPreview(best.contentJson),
    attachmentCount: best.attachments?.length ?? 0,
    isCheckedOut: best.id === loadedDraftId,
  }
}

/**
 * The checked-out row when there is one, else the newest NON-STASHED row — what
 * a resting affordance should advertise. A stashed row (`stashedAt` set) is the
 * user's durable "put away": advertising it — and the open-time auto-restore
 * that follows the advertisement — would un-do the stash on the next tap, which
 * is exactly the v1 board bug. A ROAMED row (no pointer here, not stashed)
 * keeps the zero-tap continue. Checked-out wins even over the stash flag: a
 * row can be BOTH on a second device (another device stashes while this one
 * has it checked out — pointers are device-local, and the flag rides
 * last-writer-wins content), and a composer that visibly holds the draft must
 * keep advertising what it holds.
 */
function bestRow(rows: CachedDraft[], loadedDraftId: string | null): CachedDraft | null {
  const withPayload = rows.filter(hasPayload)
  const checkedOut = withPayload.find((row) => row.id === loadedDraftId)
  if (checkedOut) return checkedOut
  const advertisable = withPayload.filter((row) => row.stashedAt == null)
  if (advertisable.length === 0) return null
  return advertisable.reduce((a, b) => (b.clientUpdatedAt > a.clientUpdatedAt ? b : a))
}

const THREAD_DRAFT_SCOPE_PREFIX = "thread:"
const STREAM_DRAFT_SCOPE_PREFIX = "stream:"

interface BoardDraftsSnapshot {
  previewByScope: Map<string, ScopeDraftPreview>
  subtopicByMessageId: Map<string, SubtopicDraftEntry>
  /** Scopes whose row is checked out into this device's composer, payload or
   *  not — an empty checked-out row is a composer mid-edit, not a resolved one. */
  checkedOutScopes: Set<string>
  /**
   * Every scope with at least one PAYLOAD row, stashed or not — the MEMBERSHIP
   * set. Advertising (`previewByScope`) filters stashed rows out, but a stashed
   * draft still exists: the board's `?drafts=true` narrowing and other
   * membership surfaces must keep its conversation, or a stash makes the draft
   * unreachable from the very view named after drafts.
   */
  payloadScopes: Set<string>
  /** `thread:{anchorId}` drafts keyed by anchor — the reply a timeline item
   *  carries before its thread stream exists. */
  threadDraftByAnchorId: Map<string, ScopeDraftPreview>
  /** `stream:{streamId}` drafts keyed by stream — where a thread reply's scope
   *  lands after promotion (and, harmlessly, every channel/scratchpad draft;
   *  lookups are by thread stream id). */
  threadDraftByStreamId: Map<string, ScopeDraftPreview>
}

const EMPTY_SNAPSHOT: BoardDraftsSnapshot = {
  previewByScope: new Map(),
  subtopicByMessageId: new Map(),
  checkedOutScopes: new Set(),
  payloadScopes: new Set(),
  threadDraftByAnchorId: new Map(),
  threadDraftByStreamId: new Map(),
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
  const checkedOutScopes = new Set<string>()
  const payloadScopes = new Set<string>()
  const threadDraftByAnchorId = new Map<string, ScopeDraftPreview>()
  const threadDraftByStreamId = new Map<string, ScopeDraftPreview>()
  for (const [scope, scopeRows] of byScope) {
    const loadedDraftId = loadedByScope.get(scope) ?? null
    const best = bestRow(scopeRows, loadedDraftId)
    if (!scope.startsWith(BOARD_DRAFT_SCOPE_PREFIX)) {
      if (best && scope.startsWith(THREAD_DRAFT_SCOPE_PREFIX)) {
        threadDraftByAnchorId.set(scope.slice(THREAD_DRAFT_SCOPE_PREFIX.length), toPreview(best, loadedDraftId))
      } else if (best && scope.startsWith(STREAM_DRAFT_SCOPE_PREFIX)) {
        threadDraftByStreamId.set(scope.slice(STREAM_DRAFT_SCOPE_PREFIX.length), toPreview(best, loadedDraftId))
      }
      continue
    }
    if (loadedDraftId !== null && scopeRows.some((row) => row.id === loadedDraftId)) checkedOutScopes.add(scope)
    if (scopeRows.some(hasPayload)) payloadScopes.add(scope)
    if (best) previewByScope.set(scope, toPreview(best, loadedDraftId))
    const parsed = parseBoardDraftKey(scope)
    if (parsed?.kind === "subtopic") {
      // The fork indicator is MEMBERSHIP, not advertising: it marks "an unsent
      // sub-topic draft exists here" and its tap is an explicit open — the
      // in-situ equivalent of a pile row — so a put-away draft keeps it (the
      // required presentation per Kris's 2026-07-13 ruling). Only the
      // auto-restoring resting affordances read the stash-filtered preview.
      const withPayload = scopeRows.filter(hasPayload)
      const member =
        withPayload.find((row) => row.id === loadedDraftId) ??
        (withPayload.length > 0 ? withPayload.reduce((a, b) => (b.clientUpdatedAt > a.clientUpdatedAt ? b : a)) : null)
      if (member) {
        subtopicByMessageId.set(parsed.messageId, {
          ...toPreview(member, loadedDraftId),
          scope,
          streamId: parsed.streamId,
          messageId: parsed.messageId,
        })
      }
    }
  }
  return {
    previewByScope,
    subtopicByMessageId,
    checkedOutScopes,
    payloadScopes,
    threadDraftByAnchorId,
    threadDraftByStreamId,
  }
}

// INV-9 exception: one shared drafts liveQuery per workspace, ref-counted
// across every resting affordance that advertises a draft (card reply buttons,
// branch-tail pills, sub-topic indicators, in-stream thread cards). Drafts per
// user are few, so the query covers the whole workspace rather than one range
// per scope family — a thread draft is looked up under two keys at once
// (`thread:{anchor}` and `stream:{threadId}`), which only one snapshot can
// answer without a gap at promotion. Per-affordance queries can never
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
        db.drafts.where("workspaceId").equals(workspaceId).toArray(),
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
 * Board scopes only (`board:*`) — `previewByScope` is built from that prefix
 * alone, so any other scope would silently read null (INV-11: fail loudly).
 * A thread reply draft reads through {@link useThreadDraft} instead.
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
 * The viewer's unsent reply draft for a timeline anchor — what the in-stream
 * thread card indicates. A thread reply draft lives under `thread:{anchorId}`
 * until the thread stream exists and under `stream:{threadId}` after promotion
 * re-scopes it; both keys are read off the SAME snapshot, so the atomic rescope
 * can never show a frame where neither holds the row. The stream key wins — it
 * is the post-promotion truth, and a stale anchor-keyed sibling (a stash
 * composed before promotion) must not outrank it.
 *
 * Advertise semantics are the board's ({@link useScopeDraftPreview}): payload
 * rows only, stashed rows hidden unless checked out into this device's composer.
 * Null when there is nothing to indicate.
 */
export function useThreadDraft(
  workspaceId: string,
  anchorId: string,
  threadId?: string | null
): ScopeDraftPreview | null {
  const subscribe = useBoardDraftsSubscription(workspaceId)
  const getSnapshot = useCallback(() => {
    const snapshot = boardDraftsRegistry.get(workspaceId)?.snapshot
    if (!snapshot) return null
    const byStream = threadId ? snapshot.threadDraftByStreamId.get(threadId) : undefined
    return byStream ?? snapshot.threadDraftByAnchorId.get(anchorId) ?? null
  }, [workspaceId, anchorId, threadId])
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

/**
 * Board scopes whose draft row is checked out into this device's composer,
 * whether or not it currently holds anything. Membership surfaces (the drafts
 * view) union this with {@link useBoardScopeDraftIndex}: clearing the text
 * mid-rewrite empties the payload but the row survives until the draft is sent
 * or discarded, and only then should the card shed.
 */
export function useBoardCheckedOutDraftScopes(workspaceId: string): ReadonlySet<string> {
  const subscribe = useBoardDraftsSubscription(workspaceId)
  const getSnapshot = useCallback(
    () => boardDraftsRegistry.get(workspaceId)?.snapshot.checkedOutScopes ?? EMPTY_SNAPSHOT.checkedOutScopes,
    [workspaceId]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Board scopes holding at least one payload draft row, STASHED INCLUDED — the
 * membership set for surfaces that answer "does this conversation have a
 * draft?" (the board's `?drafts=true` narrowing). Deliberately wider than
 * {@link useBoardScopeDraftIndex}, which is the ADVERTISE set and hides
 * stashed rows so resting buttons don't un-do a stash.
 */
export function useBoardDraftPayloadScopes(workspaceId: string): ReadonlySet<string> {
  const subscribe = useBoardDraftsSubscription(workspaceId)
  const getSnapshot = useCallback(
    () => boardDraftsRegistry.get(workspaceId)?.snapshot.payloadScopes ?? EMPTY_SNAPSHOT.payloadScopes,
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
