import { useCallback, useMemo, useRef, useState } from "react"
import { type CachedDraft, type CachedStream } from "@/db"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"
import { isDraftInHostPile, resolveDraftHomeStream, type DraftPileContext } from "@/lib/drafts/home-stream"
import { useComposerLoadedFromStore, useDraftsFromStore } from "@/stores/draft-store"
import { conversationPanelHref } from "@/lib/board/panel-href"
import { useMountedComposerScopes } from "./use-draft-composer"
import { useWorkspaceStreamsRaw } from "@/stores/workspace-store"
import { deleteDraftById } from "@/sync/draft-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { draftHasPayload, isStreamArchived } from "./use-all-drafts"
import { draftScopesSignature, useBoardDraftContext, useThreadAnchorContext } from "./use-board-draft-context"

// Re-exported so components (which cannot import from `@/db` per INV-15) can
// still get the row type they render without reaching into the data layer.
// A "stashed" draft is just a `CachedDraft` that isn't the loaded one for its
// scope — there is no separate stash entity, plaintext or sealed.
export type { CachedDraft }

/** Where a pile row came from, as structured data for presentation (INV-46). */
export type StashedDraftSource =
  | { kind: "stream"; streamId: string }
  | { kind: "conversation"; conversationId: string }
  | { kind: "branch"; conversationId: string }
  | { kind: "thread"; anchorId: string; streamId: string | null }
  | { kind: "subtopic"; streamId: string; messageId: string }

/**
 * A pile row's provenance. `tier` is the safety the widened pile carries in
 * presentation instead of exclusion: `own` is this host's exact scope, `borrowed`
 * is somewhere else under the same root stream. `title` is the owning
 * conversation's topic summary when the post is cached — null otherwise, and the
 * renderer falls back to the stream (sub-topics) or to the explorer's generic
 * wording. Stream names are deliberately NOT resolved here: they are
 * viewer-specific (DMs) and belong to `lib/streams`.
 */
export type StashedDraftOrigin = StashedDraftSource & {
  tier: "own" | "borrowed"
  /**
   * A DIFFERENT scope's composer pointer currently references this draft.
   * Restoring still works by taking the draft over, but the picker
   * shows a quiet hint so the take-over is informed rather than surprising.
   */
  checkedOutElsewhere: boolean
  /**
   * Set when tapping this row should NAVIGATE instead of restoring here: a
   * branch reply (its composer lives only on the parent conversation's panel),
   * or a conversation row whose own
   * composer is MOUNTED right now (an open panel's docked footer): adopting
   * would arm a host whose yield-to-panel effect immediately un-arms it — a
   * silent no-op — so the row takes the user to the composer that already shows
   * (or will claim) the draft.
   */
  openHref: string | null
  /**
   * The conversation whose panel `openHref` lands on, for the arrival focus
   * signal (`requestConversationReplyOpen`) — a same-URL navigation is a no-op
   * router-side, so focus must ride a store hand-off, not the URL.
   */
  openConversationId: string | null
  /**
   * False only for the manual-pickup fallback (branch with an uncached parent):
   * the destination panel shows the conversation but cannot check the draft out
   * — the hint copy must not promise "its own composer" there.
   */
  openCarriesDraft: boolean
  /** The owning conversation's topic summary, when it has one. */
  title: string | null
  /**
   * The stream the origin sits in, for the label's middle rung. A conversation
   * has no `topicSummary` until the boundary extractor has run, which is exactly
   * the newest conversations — the ones a pile is most likely to be showing. The
   * drafts explorer falls back to the anchor stream's name before its generic
   * phrase, and the picker has to climb the same ladder or the two surfaces name
   * the same draft differently.
   */
  anchorStreamId: string | null
}

export interface UseStashedDraftsResult {
  /** The pile the picker renders: every draft that could have been written under this host's root stream, minus only THIS host's loaded one (already on screen). Own rows first, then borrowed; each group newest first. */
  drafts: CachedDraft[]
  /** Where each pile row came from, and its tier, keyed by draft id. */
  originByDraftId: Map<string, StashedDraftOrigin>
  /**
   * Re-read at mutation time, not at pile time: whether this host may hold a
   * draft from another scope. Pile membership is a render old by the time the
   * user clicks a row, and the answer moves (a stream row hydrates, a late
   * `e2eEnabled` lands, the stream is archived).
   */
  canHostForeignDraft: () => boolean
  /**
   * The structured origin of an arbitrary scope, from the same derivation the
   * pile labels use — so a restore decides on `kind`, not on re-parsed scope
   * strings (INV-35). No tier: the caller knows its own scope.
   */
  describeScope: (scope: string) => StashedDraftSource | null
  /** Delete a stashed row (and mirror the removal to the backend). */
  deleteStashedDraft: (id: string) => Promise<void>
  /**
   * Tell the pile the picker is open. Membership is latched while it is: the
   * home stream is live data (a conversation can cache or move mid-pick) and a
   * row must not disappear under the user's cursor.
   */
  setPileOpen: (open: boolean) => void
}

function draftSource(
  scope: string,
  streamByAnchorId: ReadonlyMap<string, { streamId: string }>
): StashedDraftSource | null {
  if (scope.startsWith("stream:")) {
    const streamId = scope.slice("stream:".length)
    return streamId ? { kind: "stream", streamId } : null
  }
  if (scope.startsWith("thread:")) {
    const anchorId = scope.slice("thread:".length)
    if (!anchorId) return null
    return { kind: "thread", anchorId, streamId: streamByAnchorId.get(anchorId)?.streamId ?? null }
  }
  const board = parseBoardDraftKey(scope)
  if (!board) return null
  if (board.kind === "reply") return { kind: "conversation", conversationId: board.conversationId }
  if (board.kind === "branch-reply") return { kind: "branch", conversationId: board.conversationId }
  return { kind: "subtopic", streamId: board.streamId, messageId: board.messageId }
}

/** Encrypted directly, or under an encrypted root. An uncached stream fails closed. */
function isStreamEncrypted(streamId: string, streamMap: Map<string, CachedStream>): boolean {
  const stream = streamMap.get(streamId)
  if (!stream) return true
  if (stream.e2eEnabled) return true
  const root = stream.rootStreamId ? streamMap.get(stream.rootStreamId) : null
  return root?.e2eEnabled === true
}

/**
 * Whether this host may hold a draft from another scope at all: its home stream
 * resolves, is confirmed plaintext, and is active. A stream we can't confirm
 * keeps the pile scope-exact, and the same predicate re-runs inside the restore
 * mutation — a late `e2eEnabled` resolve must never leave a plaintext board
 * draft targeted where `purgePlaintextScopeDrafts` deletes it.
 */
function isHostHomeEligible(
  scope: string,
  pileContext: DraftPileContext,
  streamMap: Map<string, CachedStream>,
  archivedStreamIds: ReadonlySet<string>
): boolean {
  const home = resolveDraftHomeStream(scope, pileContext)
  if (!home) return false
  return !isStreamEncrypted(home, streamMap) && !isStreamArchived(home, streamMap, archivedStreamIds)
}

/**
 * The stashed drafts a composer offers — every draft the user could plausibly
 * have written from here, loaded elsewhere or not; the only exclusion is this
 * host's own loaded draft, which is already on screen. A row checked out under
 * another scope is offered with `checkedOutElsewhere` set and a tap takes it.
 * Pointers do not detach on navigation, so hiding loaded rows would leave almost
 * nothing shareable.
 *
 * "Could have written here" is {@link isDraftInHostPile}: one root stream, then
 * own scope / same conversation / a top-level draft / a top-level host offering
 * this root's conversations. A draft in a thread that is part of no conversation
 * is the one thing left out; two different conversations never share a pile.
 * What keeps the rest safe is presentation, not exclusion: a row from another
 * scope is tiered `borrowed` and ordered after every `own` row.
 *
 * An unresolvable home (an uncached conversation, an uncached thread anchor) is
 * never membership, and the exclusion is re-derived every render rather than
 * latched: the board-post map is empty on the first frame, so a `board:reply:`
 * scope resolves `null` transiently before it flips. When this host's own home
 * is unresolvable — or is archived, encrypted, or uncached (a scratchpad, which
 * has no `db.streams` row, lands here) — the pile stays scope-exact.
 *
 * Stash and restore are pointer moves (see `useStashComposer`): the loaded draft
 * is simply detached/attached via the `composerLoaded` pointer, so a sealed E2E
 * draft rides the same path with no plaintext snapshot (E2EE-4). This hook owns
 * only the read and delete; deletion routes through the same `deleteDraftById`
 * the Drafts explorer uses so the two surfaces can't drift.
 */
export function useStashedDrafts(workspaceId: string, scope: string | undefined): UseStashedDraftsResult {
  const allDrafts = useDraftsFromStore(workspaceId)
  const loaded = useComposerLoadedFromStore(workspaceId)
  const cachedStreams = useWorkspaceStreamsRaw(workspaceId)

  const loadedId = scope ? (loaded.find((row) => row.scope === scope)?.draftId ?? null) : null
  const mountedScopes = useMountedComposerScopes(workspaceId)
  // Where each draft is checked out, if anywhere. A loaded row remains
  // available; the pointer only annotates the origin so take-over is informed.
  const pointerScopeByDraftId = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of loaded) if (row.draftId) map.set(row.draftId, row.scope)
    return map
  }, [loaded])

  const streamMap = useMemo(() => {
    const map = new Map<string, CachedStream>()
    for (const stream of cachedStreams ?? []) map.set(stream.id, stream)
    return map
  }, [cachedStreams])

  const archivedStreamIds = useMemo(() => {
    const ids = new Set<string>()
    for (const stream of cachedStreams ?? []) if (stream.archivedAt) ids.add(stream.id)
    return ids
  }, [cachedStreams])

  const candidates = useMemo(() => allDrafts.filter(draftHasPayload), [allDrafts])

  const pileScopes = useMemo(() => {
    const scopes = candidates.map((draft) => draft.scope)
    return scope ? [...scopes, scope] : scopes
  }, [candidates, scope])

  // Only the board scopes actually in play. A plain `board:reply:` scope keeps
  // `useBoardDraftContext` on its `bulkGet` path; a branch or sub-topic scope is
  // what puts it on the workspace-wide `db.conversations` scan, and those are the
  // only scopes whose owning conversation can't be named without it.
  const boardContextSignature = useMemo(
    () => draftScopesSignature(pileScopes.filter((candidate) => parseBoardDraftKey(candidate) !== null)),
    [pileScopes]
  )

  // The anchor ids the pile has to resolve: a `thread:` scope's own anchor, the
  // anchor a thread stream hangs off (so a `stream:<threadId>` draft can name its
  // conversation), and a sub-topic's fork message. Keyed lookups, no scan.
  const anchorIdsSignature = useMemo(() => {
    const anchorIds: string[] = []
    for (const candidate of pileScopes) {
      if (candidate.startsWith("thread:")) {
        anchorIds.push(candidate.slice("thread:".length))
        continue
      }
      if (candidate.startsWith("stream:")) {
        const row = streamMap.get(candidate.slice("stream:".length))
        const anchorId = row?.parentAnchorId ?? row?.parentMessageId
        if (anchorId) anchorIds.push(anchorId)
        continue
      }
      const board = parseBoardDraftKey(candidate)
      if (board?.kind === "subtopic") anchorIds.push(board.messageId)
    }
    return draftScopesSignature(anchorIds.filter(Boolean))
  }, [pileScopes, streamMap])

  const { boardPostMap, hostPostByMessageId, parentPostByBranchConversationId } = useBoardDraftContext(
    workspaceId,
    boardContextSignature
  )
  const { streamByAnchorId, conversationIdByAnchorId } = useThreadAnchorContext(workspaceId, anchorIdsSignature)

  // A message's owning conversation, from every source already loaded: the
  // per-anchor backfill rows, the fork hosts, and the message lists of the
  // conversations the scopes themselves name.
  const conversationIdByMessageId = useMemo(() => {
    const map = new Map<string, string>(conversationIdByAnchorId)
    for (const [messageId, post] of hostPostByMessageId) map.set(messageId, post.id)
    for (const post of boardPostMap.values()) {
      for (const messageId of post.conversation.messageIds ?? []) map.set(messageId, post.id)
    }
    return map
  }, [conversationIdByAnchorId, hostPostByMessageId, boardPostMap])

  const parentConversationIdByBranchId = useMemo(() => {
    const map = new Map<string, string>()
    for (const [branchId, post] of parentPostByBranchConversationId) map.set(branchId, post.id)
    return map
  }, [parentPostByBranchConversationId])

  const pileContext = useMemo<DraftPileContext>(
    () => ({
      streamById: streamMap,
      boardPostByConversationId: boardPostMap,
      threadAnchorStreamById: streamByAnchorId,
      conversationIdByMessageId,
      parentConversationIdByBranchId,
    }),
    [streamMap, boardPostMap, streamByAnchorId, conversationIdByMessageId, parentConversationIdByBranchId]
  )

  const scopeExact = useMemo(() => {
    if (!workspaceId || !scope) return []
    return (
      allDrafts
        // No payload filter here, deliberately: a draft carrying only context refs
        // (seeded with a context bag) has an empty body and no attachments,
        // and the explorer already skips it — the scope's own picker is the last
        // surface that can reach it, so filtering here would strand it while it
        // keeps syncing. The only exclusion is this host's own loaded draft (it's
        // already on screen); a row checked out ELSEWHERE stays claimable — the
        // restore takes it over.
        .filter((draft) => draft.scope === scope && draft.id !== loadedId)
        .sort((a, b) => b.clientUpdatedAt - a.clientUpdatedAt)
    )
  }, [allDrafts, workspaceId, scope, loadedId])

  const comparePile = useCallback(
    (a: CachedDraft, b: CachedDraft) => {
      const tier = (draft: CachedDraft) => (draft.scope === scope ? 0 : 1)
      return tier(a) - tier(b) || b.clientUpdatedAt - a.clientUpdatedAt
    },
    [scope]
  )

  const livePile = useMemo(() => {
    if (!workspaceId || !scope) return []
    // A stream we can't confirm is plaintext and active keeps the pile private:
    // a plaintext board draft must never be offered into a sealed composer, and
    // an archived stream's pile is nobody else's business.
    if (!isHostHomeEligible(scope, pileContext, streamMap, archivedStreamIds)) return scopeExact

    const borrowed = candidates
      .filter(
        (draft) => draft.scope !== scope && draft.id !== loadedId && isDraftInHostPile(scope, draft.scope, pileContext)
      )
      .sort((a, b) => b.clientUpdatedAt - a.clientUpdatedAt)
    return [...scopeExact, ...borrowed]
  }, [workspaceId, scope, pileContext, scopeExact, candidates, loadedId, streamMap, archivedStreamIds])

  // Latch while the picker is open — see `setPileOpen`.
  const [pileOpen, setPileOpen] = useState(false)
  const latchedIdsRef = useRef<string[] | null>(null)
  const draftsById = useMemo(() => {
    const map = new Map<string, CachedDraft>()
    for (const draft of allDrafts) map.set(draft.id, draft)
    return map
  }, [allDrafts])

  const drafts = useMemo(() => {
    if (!pileOpen) {
      latchedIdsRef.current = null
      return livePile
    }
    if (!latchedIdsRef.current) latchedIdsRef.current = livePile.map((draft) => draft.id)
    const rows = new Map<string, CachedDraft>()
    for (const id of latchedIdsRef.current) {
      const row = draftsById.get(id)
      // A row that was deleted, emptied, or that became THIS host's loaded draft
      // still goes — the latch holds membership against a moving home stream, not
      // the row. Checked-out rows stay offered for take-over. "Emptied" applies
      // to borrowed rows
      // only; an own row carrying just context refs is legitimately body-less
      // (see `scopeExact`).
      if (!row || row.id === loadedId) continue
      if (row.scope !== scope && !draftHasPayload(row)) continue
      rows.set(id, row)
    }
    for (const row of livePile) rows.set(row.id, row)
    return [...rows.values()].sort(comparePile)
  }, [pileOpen, livePile, draftsById, loadedId, comparePile, scope])

  const originByDraftId = useMemo(() => {
    const topicSummary = (source: StashedDraftSource): string | null => {
      if (source.kind === "conversation" || source.kind === "branch") {
        return boardPostMap.get(source.conversationId)?.conversation.topicSummary ?? null
      }
      if (source.kind === "subtopic") {
        return hostPostByMessageId.get(source.messageId)?.conversation.topicSummary ?? null
      }
      return null
    }
    const anchorStream = (source: StashedDraftSource): string | null => {
      if (source.kind === "conversation" || source.kind === "branch") {
        return boardPostMap.get(source.conversationId)?.conversation.streamId ?? null
      }
      if (source.kind === "subtopic") return source.streamId
      if (source.kind === "thread") return source.streamId
      if (source.kind === "stream") return source.streamId
      return null
    }
    const map = new Map<string, StashedDraftOrigin>()
    for (const draft of drafts) {
      const source = draftSource(draft.scope, streamByAnchorId)
      if (!source) continue
      const pointerScope = pointerScopeByDraftId.get(draft.id)
      const navigateTarget = ((): { href: string; conversationId: string; carriesDraft: boolean } | null => {
        // Only BORROWED rows ever navigate: the host's own rows (a branch
        // composer's own stash included) restore in place via `same-scope`.
        if (draft.scope === scope) return null
        if (source.kind === "branch") {
          const parent = parentPostByBranchConversationId.get(source.conversationId)
          if (parent) {
            return {
              href: conversationPanelHref(workspaceId, parent.id, parent.conversation.streamId, draft.id),
              conversationId: parent.id,
              carriesDraft: true,
            }
          }
          // Parent unresolvable: the branch's own panel still shows the
          // conversation for manual pickup (mirrors the drafts explorer).
          return {
            href: conversationPanelHref(workspaceId, source.conversationId, anchorStream(source)),
            conversationId: source.conversationId,
            carriesDraft: false,
          }
        }
        if (source.kind === "conversation" && mountedScopes.has(draft.scope)) {
          // Loaded there already -> the href may equal the CURRENT url (panel
          // open beside the host), so arrival focus rides the reply-open store,
          // never the URL; stashed -> also carry ?stash= for the mounted
          // composer's own claim effect.
          const stashId = pointerScope === draft.scope ? undefined : draft.id
          return {
            href: conversationPanelHref(workspaceId, source.conversationId, anchorStream(source), stashId),
            conversationId: source.conversationId,
            carriesDraft: true,
          }
        }
        return null
      })()
      map.set(draft.id, {
        ...source,
        tier: draft.scope === scope ? "own" : "borrowed",
        checkedOutElsewhere: pointerScope !== undefined && pointerScope !== scope,
        openHref: navigateTarget?.href ?? null,
        openConversationId: navigateTarget?.conversationId ?? null,
        openCarriesDraft: navigateTarget?.carriesDraft ?? false,
        title: topicSummary(source),
        anchorStreamId: anchorStream(source),
      })
    }
    return map
  }, [
    drafts,
    scope,
    workspaceId,
    streamByAnchorId,
    boardPostMap,
    hostPostByMessageId,
    pointerScopeByDraftId,
    parentPostByBranchConversationId,
    mountedScopes,
  ])

  const canHostForeignDraft = useCallback(
    () => !!workspaceId && !!scope && isHostHomeEligible(scope, pileContext, streamMap, archivedStreamIds),
    [workspaceId, scope, pileContext, streamMap, archivedStreamIds]
  )

  const describeScope = useCallback((candidate: string) => draftSource(candidate, streamByAnchorId), [streamByAnchorId])

  const syncEngine = useOptionalSyncEngine()

  const deleteStashedDraft = useCallback(
    async (id: string) => {
      await deleteDraftById(workspaceId, id)
      syncEngine?.kickOperationQueue()
    },
    [workspaceId, syncEngine]
  )

  return {
    drafts,
    originByDraftId,
    canHostForeignDraft,
    describeScope,
    deleteStashedDraft,
    setPileOpen,
  }
}
