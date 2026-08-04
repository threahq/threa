import { useCallback, useMemo, useRef, useState } from "react"
import { type CachedDraft, type CachedStream } from "@/db"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"
import { hasSeededDraftCache, useComposerLoadedFromStore, useDraftsFromStore } from "@/stores/draft-store"
import { useWorkspaceStreamsRaw } from "@/stores/workspace-store"
import { deleteDraftById } from "@/sync/draft-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { draftHasPayload, isStreamArchived } from "./use-all-drafts"
import { useDraftLandingSites } from "./use-draft-landing-sites"

// Re-exported so components (which cannot import from `@/db` per INV-15) can
// still get the row type they render without reaching into the data layer.
// A "stashed" draft is just a `CachedDraft` that isn't the loaded one for its
// scope — there is no separate stash entity, plaintext or sealed.
export type { CachedDraft }

/** Where a pile row came from, as structured data — chunk 5 renders it (INV-46). */
export type StashedDraftOrigin = { kind: "stream"; streamId: string } | { kind: "conversation"; conversationId: string }

export interface UseStashedDraftsResult {
  /** The pile the picker renders: every draft that lands where this host's does, minus the loaded ones. */
  drafts: CachedDraft[]
  /**
   * The subset this host may restore: its own scope's rows, minus any row already
   * checked out by a composer on this device. A row checked out under one scope is
   * neither offered nor claimable under another — two scopes holding one row make
   * their debounced saves fight over its `scope` and body.
   */
  claimableDrafts: CachedDraft[]
  /** Where each pile row came from, keyed by draft id. */
  originByDraftId: Map<string, StashedDraftOrigin>
  /** True once the draft cache has been seeded (used to suppress empty-flash in the picker). */
  isLoaded: boolean
  /** Delete a stashed row (and mirror the removal to the backend). */
  deleteStashedDraft: (id: string) => Promise<void>
  /**
   * Tell the pile the picker is open. Membership is latched while it is: the
   * landing stream is live data (a conversation can move into a thread mid-pick)
   * and a row must not disappear under the user's cursor.
   */
  setPileOpen: (open: boolean) => void
}

/** A draft scope that could land flat — the only ones worth resolving a landing site for. */
function couldLandFlat(scope: string): boolean {
  if (scope.startsWith("stream:")) return true
  return parseBoardDraftKey(scope)?.kind === "reply"
}

function draftOrigin(scope: string): StashedDraftOrigin | null {
  if (scope.startsWith("stream:")) {
    const streamId = scope.slice("stream:".length)
    return streamId ? { kind: "stream", streamId } : null
  }
  const board = parseBoardDraftKey(scope)
  return board?.kind === "reply" ? { kind: "conversation", conversationId: board.conversationId } : null
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
 * The stashed drafts a composer offers — every draft that would land in the same
 * place this host's own draft would, except the ones checked out into a composer
 * on this device.
 *
 * "The same place" is the LANDING SITE: same stream, top level. A `stream:<S>`
 * draft and a board reply to a conversation that is live in S both land flat in
 * S, so they share one pile; a thread reply, a branch reply, a sub-topic fork and
 * a board reply that would convert its lone opener into a thread all land
 * somewhere nested and are never shared. When this host's own scope doesn't land
 * flat — or lands in a stream that is archived, encrypted, or uncached — the pile
 * stays scope-exact, which is also what every nested composer gets with no
 * special case.
 *
 * `unknown` (a conversation this device hasn't cached) is never membership, and
 * the exclusion is re-derived every render rather than latched: the board-post
 * map is empty on the first frame, so a `board:reply:` scope resolves `unknown`
 * transiently before it flips.
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
  // Loaded in ANY scope on this device, not just this host's: a draft the user is
  // live-typing in another composer must never be offered here.
  const loadedAnywhere = useMemo(() => {
    const ids = new Set<string>()
    for (const row of loaded) if (row.draftId) ids.add(row.draftId)
    return ids
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

  const candidates = useMemo(
    () =>
      allDrafts.filter(
        (draft) => couldLandFlat(draft.scope) && !loadedAnywhere.has(draft.id) && draftHasPayload(draft)
      ),
    [allDrafts, loadedAnywhere]
  )

  const landingScopes = useMemo(() => {
    const scopes = candidates.map((draft) => draft.scope)
    if (scope && couldLandFlat(scope)) scopes.push(scope)
    return scopes
  }, [candidates, scope])

  const landingSites = useDraftLandingSites(workspaceId, landingScopes)

  const scopeExact = useMemo(() => {
    if (!workspaceId || !scope) return []
    return (
      allDrafts
        // No payload filter here, deliberately: a draft carrying only context refs
        // (seeded by "Discuss with Ariadne") has an empty body and no attachments,
        // and the explorer already skips it — the scope's own picker is the last
        // surface that can reach it, so filtering here would strand it while it
        // keeps syncing. `loadedAnywhere` is not optional: a row checked out under
        // any scope on this device must be claimable from none.
        .filter((draft) => draft.scope === scope && !loadedAnywhere.has(draft.id))
        .sort((a, b) => b.clientUpdatedAt - a.clientUpdatedAt)
    )
  }, [allDrafts, workspaceId, scope, loadedAnywhere])

  const livePile = useMemo(() => {
    if (!workspaceId || !scope) return []
    const host = landingSites.get(scope)
    if (host?.kind !== "flat") return scopeExact
    const landingStreamId = host.streamId
    // A stream we can't confirm is plaintext and active keeps the pile private:
    // a plaintext board draft must never be offered into a sealed composer, and
    // an archived stream's pile is nobody else's business.
    if (isStreamEncrypted(landingStreamId, streamMap)) return scopeExact
    if (isStreamArchived(landingStreamId, streamMap, archivedStreamIds)) return scopeExact

    return candidates
      .filter((draft) => {
        if (draft.id === loadedId) return false
        const site = landingSites.get(draft.scope)
        return site?.kind === "flat" && site.streamId === landingStreamId
      })
      .sort((a, b) => b.clientUpdatedAt - a.clientUpdatedAt)
  }, [workspaceId, scope, landingSites, scopeExact, candidates, loadedId, streamMap, archivedStreamIds])

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
      // A row that was deleted, emptied or checked out into a composer still goes
      // — the latch holds membership against a moving landing site, not the row.
      if (!row || !draftHasPayload(row) || loadedAnywhere.has(row.id)) continue
      rows.set(id, row)
    }
    for (const row of livePile) rows.set(row.id, row)
    return [...rows.values()].sort((a, b) => b.clientUpdatedAt - a.clientUpdatedAt)
  }, [pileOpen, livePile, draftsById, loadedAnywhere])

  const originByDraftId = useMemo(() => {
    const map = new Map<string, StashedDraftOrigin>()
    for (const draft of drafts) {
      const origin = draftOrigin(draft.scope)
      if (origin) map.set(draft.id, origin)
    }
    return map
  }, [drafts])

  const isLoaded = hasSeededDraftCache(workspaceId)
  const syncEngine = useOptionalSyncEngine()

  const deleteStashedDraft = useCallback(
    async (id: string) => {
      await deleteDraftById(workspaceId, id)
      syncEngine?.kickOperationQueue()
    },
    [workspaceId, syncEngine]
  )

  return { drafts, claimableDrafts: scopeExact, originByDraftId, isLoaded, deleteStashedDraft, setPileOpen }
}
