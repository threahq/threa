import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useBatchedValue } from "./apply-window"
import {
  getWorkspaceTableSnapshot,
  subscribeWorkspaceTable,
  type WorkspaceTableKey,
  type WorkspaceTableRowTypes,
} from "./workspace-table-registry"
// Namespace import so the shared overlay memo below is spy-able against the
// module (INV-48) — the "once per workspace, not once per consumer" property is
// only assertable through the real call.
import * as streamNameCache from "@/lib/crypto/stream-name-cache"
import {
  db,
  type CachedWorkspace,
  type CachedWorkspaceUser,
  type CachedStream,
  type CachedStreamMembership,
  type CachedStreamReadState,
  type CachedDmPeer,
  type CachedPersona,
  type CachedBot,
  type CachedLabel,
  type CachedLabelAssignment,
  type CachedUnreadState,
  type CachedUserPreferences,
  type CachedSidebarConfig,
  type CachedWorkspaceMetadata,
} from "@/db"

// Re-exported so components/pages can type the values these store hooks return
// (e.g. `useWorkspaceStreams(): CachedStream[]`) without importing `@/db`
// directly, which the component layer is barred from (INV-15).
export type { CachedBot, CachedPersona, CachedStream } from "@/db"

// In-memory cache — populated by applyWorkspaceBootstrap, used as the default
// value for useLiveQuery so the first synchronous render returns real data
// instead of empty arrays. This eliminates the one-frame flash that useLiveQuery
// causes (it's always async on first mount).
//
// The cache is NOT the source of truth — IDB is. The cache only serves as the
// initial value. Once useLiveQuery resolves (next render), IDB data takes over
// and subsequent updates flow reactively through useLiveQuery.

const cache = {
  workspaces: new Map<string, CachedWorkspace>(),
  users: new Map<string, CachedWorkspaceUser[]>(),
  streams: new Map<string, CachedStream[]>(),
  memberships: new Map<string, CachedStreamMembership[]>(),
  readStates: new Map<string, CachedStreamReadState[]>(),
  dmPeers: new Map<string, CachedDmPeer[]>(),
  personas: new Map<string, CachedPersona[]>(),
  bots: new Map<string, CachedBot[]>(),
  labels: new Map<string, CachedLabel[]>(),
  labelAssignments: new Map<string, CachedLabelAssignment[]>(),
  unreadState: new Map<string, CachedUnreadState>(),
  userPreferences: new Map<string, CachedUserPreferences>(),
  sidebarConfig: new Map<string, CachedSidebarConfig>(),
  metadata: new Map<string, CachedWorkspaceMetadata>(),
}

// Monotonic version per workspace so seedCacheFromIdb (async IDB read) never
// overwrites a fresher seedWorkspaceCache call (synchronous bootstrap write).
// ALWAYS bumped, including for a seed that publishes nothing: it orders writes,
// it does not describe change.
const cacheVersion = new Map<string, number>()

// What `useSyncExternalStore` reads. Bumped only when a seed actually changed
// something, so an unchanged bootstrap apply wakes no subscriber.
const cacheSignal = new Map<string, number>()
const cacheListeners = new Map<string, Set<() => void>>()

function emitWorkspaceCacheChange(workspaceId: string): void {
  const listeners = cacheListeners.get(workspaceId)
  if (!listeners) return
  for (const listener of listeners) listener()
}

export function subscribeWorkspaceCache(workspaceId: string | undefined, listener: () => void): () => void {
  if (!workspaceId) return () => {}

  let listeners = cacheListeners.get(workspaceId)
  if (!listeners) {
    listeners = new Set()
    cacheListeners.set(workspaceId, listeners)
  }

  listeners.add(listener)
  return () => {
    const currentListeners = cacheListeners.get(workspaceId)
    if (!currentListeners) return
    currentListeners.delete(listener)
    if (currentListeners.size === 0) {
      cacheListeners.delete(workspaceId)
    }
  }
}

function getWorkspaceCacheSnapshot(workspaceId: string | undefined): number {
  return workspaceId ? (cacheSignal.get(workspaceId) ?? 0) : 0
}

function publishWorkspaceCache(workspaceId: string): void {
  cacheSignal.set(workspaceId, (cacheSignal.get(workspaceId) ?? 0) + 1)
  emitWorkspaceCacheChange(workspaceId)
}

/**
 * Wake the caller on in-memory cache publications, but only while it still reads
 * the cache — once the table's live query has resolved, the cache no longer
 * contributes to the returned value, and waking for it re-renders every reader a
 * second time for one change (the emission already woke them).
 */
function useWorkspaceCacheSignal(workspaceId: string | undefined, active: boolean): number {
  const subscribe = useCallback(
    (listener: () => void) => (active ? subscribeWorkspaceCache(workspaceId, listener) : () => {}),
    [workspaceId, active]
  )
  const getSnapshot = useCallback(() => (active ? getWorkspaceCacheSnapshot(workspaceId) : 0), [workspaceId, active])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function hasSeededWorkspaceCache(workspaceId: string): boolean {
  return (
    cache.workspaces.has(workspaceId) &&
    cache.users.has(workspaceId) &&
    cache.streams.has(workspaceId) &&
    cache.memberships.has(workspaceId) &&
    cache.dmPeers.has(workspaceId) &&
    cache.personas.has(workspaceId) &&
    cache.bots.has(workspaceId) &&
    cache.unreadState.has(workspaceId) &&
    cache.metadata.has(workspaceId)
  )
}

export function resetWorkspaceStoreCache(): void {
  const workspaceIds = new Set([...cacheVersion.keys(), ...cacheSignal.keys(), ...cacheListeners.keys()])
  cache.workspaces.clear()
  cache.users.clear()
  cache.streams.clear()
  cache.memberships.clear()
  cache.readStates.clear()
  cache.dmPeers.clear()
  cache.personas.clear()
  cache.bots.clear()
  cache.labels.clear()
  cache.labelAssignments.clear()
  cache.unreadState.clear()
  cache.userPreferences.clear()
  cache.sidebarConfig.clear()
  cache.metadata.clear()
  cacheVersion.clear()
  nameOverlayMemo.clear()
  // cacheSignal is bumped, never cleared: resetting it to 0 and publishing 1
  // reproduces a value a mounted subscriber may already hold, and
  // useSyncExternalStore compares values — the reset would then not re-render.
  for (const workspaceId of workspaceIds) {
    publishWorkspaceCache(workspaceId)
  }
}

/**
 * Prime the in-memory cache from IndexedDB. Called on workspace layout mount
 * so that returning users with cached data bypass the coordinated loading gate
 * immediately — no network round-trip needed.
 *
 * Returns true if the cache was populated (IDB had workspace data), false otherwise.
 */
export async function seedCacheFromIdb(workspaceId: string): Promise<boolean> {
  // Capture version before async work. If applyWorkspaceBootstrap runs
  // concurrently and calls seedWorkspaceCache (which bumps the version),
  // we skip the write to avoid overwriting fresh data with stale IDB reads.
  const versionBefore = cacheVersion.get(workspaceId) ?? 0

  const [
    workspace,
    users,
    streams,
    memberships,
    readStates,
    dmPeers,
    personas,
    bots,
    labels,
    labelAssignments,
    unreadState,
    prefs,
    sidebarConfig,
    metadata,
  ] = await Promise.all([
    db.workspaces.get(workspaceId),
    db.workspaceUsers.where("workspaceId").equals(workspaceId).toArray(),
    db.streams.where("workspaceId").equals(workspaceId).toArray(),
    db.streamMemberships.where("workspaceId").equals(workspaceId).toArray(),
    db.streamReadState.where("workspaceId").equals(workspaceId).toArray(),
    db.dmPeers.where("workspaceId").equals(workspaceId).toArray(),
    db.personas.where("workspaceId").equals(workspaceId).toArray(),
    db.bots.where("workspaceId").equals(workspaceId).toArray(),
    db.labels.where("workspaceId").equals(workspaceId).toArray(),
    db.labelAssignments.where("workspaceId").equals(workspaceId).toArray(),
    db.unreadState.get(workspaceId),
    db.userPreferences.get(workspaceId),
    db.sidebarConfigs.get(workspaceId),
    db.workspaceMetadata.get(workspaceId),
  ])

  if (!workspace) return false

  // If the version bumped during our async reads, a bootstrap completed
  // and seeded fresher data — skip writing stale cache. Still publish: that
  // seed may have been publish:false (unchanged apply), and a subscriber that
  // mounted cold before it would otherwise never learn the cache is populated.
  if ((cacheVersion.get(workspaceId) ?? 0) !== versionBefore) {
    publishWorkspaceCache(workspaceId)
    return true
  }

  seedWorkspaceCache(workspaceId, {
    workspace,
    users,
    streams,
    memberships,
    readStates,
    dmPeers,
    personas,
    bots,
    labels,
    labelAssignments,
    unreadState,
    userPreferences: prefs,
    sidebarConfig,
    metadata,
  })

  return true
}

/**
 * Populate the in-memory cache from a workspace bootstrap response.
 * Called by applyWorkspaceBootstrap after writing to IDB.
 */
export function seedWorkspaceCache(
  workspaceId: string,
  data: {
    workspace: CachedWorkspace
    users: CachedWorkspaceUser[]
    streams: CachedStream[]
    memberships: CachedStreamMembership[]
    readStates?: CachedStreamReadState[]
    dmPeers: CachedDmPeer[]
    personas: CachedPersona[]
    bots: CachedBot[]
    labels?: CachedLabel[]
    labelAssignments?: CachedLabelAssignment[]
    unreadState?: CachedUnreadState
    userPreferences?: CachedUserPreferences
    sidebarConfig?: CachedSidebarConfig
    metadata?: CachedWorkspaceMetadata
  },
  options?: { publish?: boolean }
): void {
  // Bump version so concurrent seedCacheFromIdb calls know to skip. Always —
  // the version orders writes; `publish` says whether anything changed.
  cacheVersion.set(workspaceId, (cacheVersion.get(workspaceId) ?? 0) + 1)
  cache.workspaces.set(workspaceId, data.workspace)
  cache.users.set(workspaceId, data.users)
  cache.streams.set(workspaceId, data.streams)
  cache.memberships.set(workspaceId, data.memberships)
  if (data.readStates) cache.readStates.set(workspaceId, data.readStates)
  cache.dmPeers.set(workspaceId, data.dmPeers)
  cache.personas.set(workspaceId, data.personas)
  cache.bots.set(workspaceId, data.bots)
  if (data.labels) cache.labels.set(workspaceId, data.labels)
  if (data.labelAssignments) cache.labelAssignments.set(workspaceId, data.labelAssignments)
  if (data.unreadState) cache.unreadState.set(workspaceId, data.unreadState)
  if (data.userPreferences) cache.userPreferences.set(workspaceId, data.userPreferences)
  if (data.sidebarConfig) cache.sidebarConfig.set(workspaceId, data.sidebarConfig)
  if (data.metadata) cache.metadata.set(workspaceId, data.metadata)
  if (options?.publish !== false) publishWorkspaceCache(workspaceId)
}

/**
 * The arrays/singletons currently cached for a workspace, so an apply can hand
 * back the very same reference for a table its diff found unchanged.
 */
export function getCachedWorkspaceTables(workspaceId: string): {
  users?: CachedWorkspaceUser[]
  streams?: CachedStream[]
  memberships?: CachedStreamMembership[]
  readStates?: CachedStreamReadState[]
  dmPeers?: CachedDmPeer[]
  personas?: CachedPersona[]
  bots?: CachedBot[]
  labels?: CachedLabel[]
  labelAssignments?: CachedLabelAssignment[]
} {
  return {
    users: cache.users.get(workspaceId),
    streams: cache.streams.get(workspaceId),
    memberships: cache.memberships.get(workspaceId),
    readStates: cache.readStates.get(workspaceId),
    dmPeers: cache.dmPeers.get(workspaceId),
    personas: cache.personas.get(workspaceId),
    bots: cache.bots.get(workspaceId),
    labels: cache.labels.get(workspaceId),
    labelAssignments: cache.labelAssignments.get(workspaceId),
  }
}

/**
 * Patch a single user into the in-memory cache after an out-of-band write to
 * IDB (a local status/profile mutation or a socket-pushed update).
 *
 * The in-memory cache otherwise only refreshes on a full bootstrap, while
 * useLiveQuery is undefined on a component's first synchronous render — so a
 * freshly-mounted reader (e.g. the status picker, which remounts each time it
 * opens and seeds its editor once from `currentUser`) would read a stale row
 * until the next page load. Keeping the cache in step with IDB closes that gap.
 *
 * No-op when the workspace's users aren't cached yet: the pending bootstrap/seed
 * will carry the fresh row, and we must not partially populate the cache.
 */
export function upsertWorkspaceUserInCache(workspaceId: string, user: CachedWorkspaceUser): void {
  const current = cache.users.get(workspaceId)
  if (!current) return
  const exists = current.some((u) => u.id === user.id)
  cache.users.set(workspaceId, exists ? current.map((u) => (u.id === user.id ? user : u)) : [...current, user])
  cacheVersion.set(workspaceId, (cacheVersion.get(workspaceId) ?? 0) + 1)
  publishWorkspaceCache(workspaceId)
}

// Array-valued hooks read live from IDB but fall back to the in-memory
// cache while the first query is in flight, so the first visible render after
// the coordinated-loading gate opens shows real data instead of a flash of
// empty content (the cache is seeded from the same bootstrap that wrote IDB).
//
// useLiveQuery is undefined only until its first resolution; once it resolves
// it is the source of truth even when empty. We must NOT keep returning the
// cache after an empty resolution — an incremental delete (e.g. the last
// assignment removed via a socket event, which updates IDB but not the cache)
// would otherwise be masked until the next bootstrap.

// One shared empty array: a fresh `[]` per render would defeat every identity
// check downstream (the shared name overlay's memo, and any consumer memoising
// on the returned reference) for the whole pre-resolution window.
const EMPTY_ROWS: never[] = []

function useWorkspaceTable<K extends WorkspaceTableKey>(
  workspaceId: string | undefined,
  tableKey: K
): WorkspaceTableRowTypes[K][] | undefined {
  const subscribe = useCallback(
    (listener: () => void) => (workspaceId ? subscribeWorkspaceTable(workspaceId, tableKey, listener) : () => {}),
    [workspaceId, tableKey]
  )
  const getSnapshot = useCallback(
    () => (workspaceId ? getWorkspaceTableSnapshot(workspaceId, tableKey) : undefined),
    [workspaceId, tableKey]
  )
  const live = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useWorkspaceCacheSignal(workspaceId, live === undefined)
  return live
}

function useArrayStoreHook<K extends WorkspaceTableKey>(
  workspaceId: string | undefined,
  tableKey: K,
  cached: WorkspaceTableRowTypes[K][]
): WorkspaceTableRowTypes[K][] {
  const live = useWorkspaceTable(workspaceId, tableKey)
  return useBatchedValue(live ?? cached, workspaceId)
}

function useSingletonStoreHook<K extends WorkspaceTableKey>(
  workspaceId: string | undefined,
  tableKey: K,
  cached: WorkspaceTableRowTypes[K] | undefined
): WorkspaceTableRowTypes[K] | undefined {
  const rows = useWorkspaceTable(workspaceId, tableKey)
  const live = rows ? rows[0] : cached
  const resolved = live === undefined && cached !== undefined ? cached : live
  return useBatchedValue(resolved, workspaceId)
}

export function useWorkspaceFromStore(workspaceId: string | undefined): CachedWorkspace | undefined {
  const cached = workspaceId ? cache.workspaces.get(workspaceId) : undefined
  return useSingletonStoreHook(workspaceId, "workspace", cached)
}

/**
 * Whether this workspace's stream rows have RESOLVED, as opposed to the
 * pre-resolution cache fallback — which is indistinguishable from "no streams".
 * A consumer that HIDES something on `archivedAt` needs that difference, and it
 * needs to be woken when it flips: this rides the same per-table subscription
 * the row hooks use. `hasSeededWorkspaceCache` cannot serve that purpose — it
 * reads nine cache maps that no subscription here wakes on, so a gate built on
 * it can latch on whichever render happens to observe it false.
 */
export function useWorkspaceStreamsLoaded(workspaceId: string | undefined): boolean {
  return useWorkspaceTable(workspaceId, "streams") !== undefined
}

export function useWorkspaceUsers(workspaceId: string | undefined): CachedWorkspaceUser[] {
  const cached = workspaceId ? (cache.users.get(workspaceId) ?? EMPTY_ROWS) : EMPTY_ROWS
  return useArrayStoreHook(workspaceId, "users", cached)
}

/**
 * The raw cached streams — no decrypted-name overlay. The decryptor
 * (`useDecryptStreamNames`) reads this so it isn't woken by its own output: it
 * only needs the sealed ciphertext (unchanged by the overlay), and subscribing
 * to the post-overlay hook would re-run it on every name that lands.
 */
export function useWorkspaceStreamsRaw(workspaceId: string | undefined): CachedStream[] {
  const cached = workspaceId ? (cache.streams.get(workspaceId) ?? EMPTY_ROWS) : EMPTY_ROWS
  return useArrayStoreHook(workspaceId, "streams", cached)
}

/**
 * One overlay per workspace per change, not one per consumer per render: the
 * inputs are shared (the registry's rows reference and the name cache's version),
 * so 40 readers of `useWorkspaceStreams` would otherwise each walk every stream.
 */
const nameOverlayMemo = new Map<string, { rows: CachedStream[]; version: number; result: CachedStream[] }>()

function sharedNameOverlay(workspaceId: string, streams: CachedStream[], version: number): CachedStream[] {
  const memo = nameOverlayMemo.get(workspaceId)
  if (memo && memo.rows === streams && memo.version === version) return memo.result
  const result = streamNameCache.applyDecryptedNameOverlay(workspaceId, streams)
  nameOverlayMemo.set(workspaceId, { rows: streams, version, result })
  return result
}

export function useWorkspaceStreams(workspaceId: string | undefined): CachedStream[] {
  const streams = useWorkspaceStreamsRaw(workspaceId)
  // Decrypt-at-the-read-boundary: overlay the tamper-evident decrypted name onto
  // `displayName` so every label resolver reflects it without per-surface changes.
  // The plaintext lives only in the memory-only `stream-name-cache`; IDB keeps
  // ciphertext. `version` re-overlays when a decrypt lands (see `stream-name-cache`).
  const version = useSyncExternalStore(
    streamNameCache.subscribeStreamNameCache,
    streamNameCache.getStreamNameCacheVersion,
    streamNameCache.getStreamNameCacheVersion
  )
  return useMemo(
    () => (workspaceId ? sharedNameOverlay(workspaceId, streams, version) : streams),
    [streams, workspaceId, version]
  )
}

export function useWorkspaceStreamMemberships(workspaceId: string | undefined): CachedStreamMembership[] {
  const cached = workspaceId ? (cache.memberships.get(workspaceId) ?? EMPTY_ROWS) : EMPTY_ROWS
  return useArrayStoreHook(workspaceId, "memberships", cached)
}

export function useWorkspaceStreamReadStates(workspaceId: string | undefined): CachedStreamReadState[] {
  const cached = workspaceId ? (cache.readStates.get(workspaceId) ?? EMPTY_ROWS) : EMPTY_ROWS
  return useArrayStoreHook(workspaceId, "readStates", cached)
}

export function useWorkspaceDmPeers(workspaceId: string | undefined): CachedDmPeer[] {
  const cached = workspaceId ? (cache.dmPeers.get(workspaceId) ?? EMPTY_ROWS) : EMPTY_ROWS
  return useArrayStoreHook(workspaceId, "dmPeers", cached)
}

/**
 * Incrementally upsert one persona into the in-memory cache (and IDB) so a store
 * reader sees it on the next synchronous render — ahead of the owner-room
 * `agent_config:updated` broadcast. Used by the fork mutation so a just-created
 * personal persona is already owned-by-the-viewer when the editor's ownership gate
 * runs on navigate. Idempotent by id; bumps the cache version so subscribers
 * re-render.
 */
export function upsertWorkspacePersonaCache(workspaceId: string, persona: CachedPersona): void {
  const rows = cache.personas.get(workspaceId) ?? []
  const idx = rows.findIndex((p) => p.id === persona.id)
  cache.personas.set(workspaceId, idx >= 0 ? rows.map((p) => (p.id === persona.id ? persona : p)) : [...rows, persona])
  cacheVersion.set(workspaceId, (cacheVersion.get(workspaceId) ?? 0) + 1)
  publishWorkspaceCache(workspaceId)
  void db.personas.put(persona)
}

export function useWorkspacePersonas(workspaceId: string | undefined): CachedPersona[] {
  const cached = workspaceId ? (cache.personas.get(workspaceId) ?? EMPTY_ROWS) : EMPTY_ROWS
  return useArrayStoreHook(workspaceId, "personas", cached)
}

export function useWorkspaceBots(workspaceId: string | undefined): CachedBot[] {
  const cached = workspaceId ? (cache.bots.get(workspaceId) ?? EMPTY_ROWS) : EMPTY_ROWS
  return useArrayStoreHook(workspaceId, "bots", cached)
}

export function useWorkspaceLabels(workspaceId: string | undefined): CachedLabel[] {
  const cached = workspaceId ? (cache.labels.get(workspaceId) ?? EMPTY_ROWS) : EMPTY_ROWS
  return useArrayStoreHook(workspaceId, "labels", cached)
}

export function useWorkspaceLabelAssignments(workspaceId: string | undefined): CachedLabelAssignment[] {
  const cached = workspaceId ? (cache.labelAssignments.get(workspaceId) ?? EMPTY_ROWS) : EMPTY_ROWS
  return useArrayStoreHook(workspaceId, "labelAssignments", cached)
}

export function useWorkspaceUnreadState(workspaceId: string | undefined): CachedUnreadState | undefined {
  const cached = workspaceId ? cache.unreadState.get(workspaceId) : undefined
  return useSingletonStoreHook(workspaceId, "unreadState", cached)
}

export function useWorkspaceUserPreferences(workspaceId: string | undefined): CachedUserPreferences | undefined {
  const cached = workspaceId ? cache.userPreferences.get(workspaceId) : undefined
  return useSingletonStoreHook(workspaceId, "userPreferences", cached)
}

export function useWorkspaceSidebarConfig(workspaceId: string | undefined): CachedSidebarConfig | undefined {
  const cached = workspaceId ? cache.sidebarConfig.get(workspaceId) : undefined
  return useSingletonStoreHook(workspaceId, "sidebarConfig", cached)
}

export function useWorkspaceMetadata(workspaceId: string | undefined): CachedWorkspaceMetadata | undefined {
  const cached = workspaceId ? cache.metadata.get(workspaceId) : undefined
  return useSingletonStoreHook(workspaceId, "metadata", cached)
}
