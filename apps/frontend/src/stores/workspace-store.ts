import { useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  db,
  type CachedWorkspace,
  type CachedWorkspaceUser,
  type CachedStream,
  type CachedStreamMembership,
  type CachedDmPeer,
  type CachedPersona,
  type CachedBot,
  type CachedLabel,
  type CachedLabelMembership,
  type CachedLabelAssignment,
  type CachedUnreadState,
  type CachedUserPreferences,
  type CachedSidebarConfig,
  type CachedWorkspaceMetadata,
} from "@/db"

// Re-exported so components/pages can type the values these store hooks return
// (e.g. `useWorkspaceStreams(): CachedStream[]`) without importing `@/db`
// directly, which the component layer is barred from (INV-15).
export type { CachedStream } from "@/db"

// =============================================================================
// In-memory cache — populated by applyWorkspaceBootstrap, used as the default
// value for useLiveQuery so the first synchronous render returns real data
// instead of empty arrays. This eliminates the one-frame flash that useLiveQuery
// causes (it's always async on first mount).
//
// The cache is NOT the source of truth — IDB is. The cache only serves as the
// initial value. Once useLiveQuery resolves (next render), IDB data takes over
// and subsequent updates flow reactively through useLiveQuery.
// =============================================================================

const cache = {
  workspaces: new Map<string, CachedWorkspace>(),
  users: new Map<string, CachedWorkspaceUser[]>(),
  streams: new Map<string, CachedStream[]>(),
  memberships: new Map<string, CachedStreamMembership[]>(),
  dmPeers: new Map<string, CachedDmPeer[]>(),
  personas: new Map<string, CachedPersona[]>(),
  bots: new Map<string, CachedBot[]>(),
  labels: new Map<string, CachedLabel[]>(),
  labelMemberships: new Map<string, CachedLabelMembership[]>(),
  labelAssignments: new Map<string, CachedLabelAssignment[]>(),
  unreadState: new Map<string, CachedUnreadState>(),
  userPreferences: new Map<string, CachedUserPreferences>(),
  sidebarConfig: new Map<string, CachedSidebarConfig>(),
  metadata: new Map<string, CachedWorkspaceMetadata>(),
}

// Monotonic version per workspace so seedCacheFromIdb (async IDB read) never
// overwrites a fresher seedWorkspaceCache call (synchronous bootstrap write).
const cacheVersion = new Map<string, number>()
const cacheListeners = new Map<string, Set<() => void>>()

function emitWorkspaceCacheChange(workspaceId: string): void {
  const listeners = cacheListeners.get(workspaceId)
  if (!listeners) return
  for (const listener of listeners) listener()
}

function subscribeWorkspaceCache(workspaceId: string | undefined, listener: () => void): () => void {
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
  return workspaceId ? (cacheVersion.get(workspaceId) ?? 0) : 0
}

function useWorkspaceCacheSignal(workspaceId: string | undefined): number {
  return useSyncExternalStore(
    (listener) => subscribeWorkspaceCache(workspaceId, listener),
    () => getWorkspaceCacheSnapshot(workspaceId),
    () => getWorkspaceCacheSnapshot(workspaceId)
  )
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
  const workspaceIds = new Set([...cacheVersion.keys(), ...cacheListeners.keys()])
  cache.workspaces.clear()
  cache.users.clear()
  cache.streams.clear()
  cache.memberships.clear()
  cache.dmPeers.clear()
  cache.personas.clear()
  cache.bots.clear()
  cache.labels.clear()
  cache.labelMemberships.clear()
  cache.labelAssignments.clear()
  cache.unreadState.clear()
  cache.userPreferences.clear()
  cache.sidebarConfig.clear()
  cache.metadata.clear()
  cacheVersion.clear()
  for (const workspaceId of workspaceIds) {
    emitWorkspaceCacheChange(workspaceId)
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
    dmPeers,
    personas,
    bots,
    labels,
    labelMemberships,
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
    db.dmPeers.where("workspaceId").equals(workspaceId).toArray(),
    db.personas.where("workspaceId").equals(workspaceId).toArray(),
    db.bots.where("workspaceId").equals(workspaceId).toArray(),
    db.labels.where("workspaceId").equals(workspaceId).toArray(),
    db.labelMemberships.where("workspaceId").equals(workspaceId).toArray(),
    db.labelAssignments.where("workspaceId").equals(workspaceId).toArray(),
    db.unreadState.get(workspaceId),
    db.userPreferences.get(workspaceId),
    db.sidebarConfigs.get(workspaceId),
    db.workspaceMetadata.get(workspaceId),
  ])

  if (!workspace) return false

  // If the version bumped during our async reads, a bootstrap completed
  // and seeded fresher data — skip writing stale cache.
  if ((cacheVersion.get(workspaceId) ?? 0) !== versionBefore) return true

  seedWorkspaceCache(workspaceId, {
    workspace,
    users,
    streams,
    memberships,
    dmPeers,
    personas,
    bots,
    labels,
    labelMemberships,
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
    dmPeers: CachedDmPeer[]
    personas: CachedPersona[]
    bots: CachedBot[]
    labels?: CachedLabel[]
    labelMemberships?: CachedLabelMembership[]
    labelAssignments?: CachedLabelAssignment[]
    unreadState?: CachedUnreadState
    userPreferences?: CachedUserPreferences
    sidebarConfig?: CachedSidebarConfig
    metadata?: CachedWorkspaceMetadata
  }
): void {
  // Bump version so concurrent seedCacheFromIdb calls know to skip.
  cacheVersion.set(workspaceId, (cacheVersion.get(workspaceId) ?? 0) + 1)
  cache.workspaces.set(workspaceId, data.workspace)
  cache.users.set(workspaceId, data.users)
  cache.streams.set(workspaceId, data.streams)
  cache.memberships.set(workspaceId, data.memberships)
  cache.dmPeers.set(workspaceId, data.dmPeers)
  cache.personas.set(workspaceId, data.personas)
  cache.bots.set(workspaceId, data.bots)
  if (data.labels) cache.labels.set(workspaceId, data.labels)
  if (data.labelMemberships) cache.labelMemberships.set(workspaceId, data.labelMemberships)
  if (data.labelAssignments) cache.labelAssignments.set(workspaceId, data.labelAssignments)
  if (data.unreadState) cache.unreadState.set(workspaceId, data.unreadState)
  if (data.userPreferences) cache.userPreferences.set(workspaceId, data.userPreferences)
  if (data.sidebarConfig) cache.sidebarConfig.set(workspaceId, data.sidebarConfig)
  if (data.metadata) cache.metadata.set(workspaceId, data.metadata)
  emitWorkspaceCacheChange(workspaceId)
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
  emitWorkspaceCacheChange(workspaceId)
}

// =============================================================================
// Store hooks — useLiveQuery for reactivity, in-memory cache for first render
// =============================================================================

// ---------------------------------------------------------------------------
// Helper: array-valued hooks read live from IDB but fall back to the in-memory
// cache while the first query is in flight, so the first visible render after
// the coordinated-loading gate opens shows real data instead of a flash of
// empty content (the cache is seeded from the same bootstrap that wrote IDB).
//
// useLiveQuery is undefined only until its first resolution; once it resolves
// it is the source of truth even when empty. We must NOT keep returning the
// cache after an empty resolution — an incremental delete (e.g. the last
// assignment removed via a socket event, which updates IDB but not the cache)
// would otherwise be masked until the next bootstrap.
// ---------------------------------------------------------------------------

function useArrayStoreHook<T>(queryFn: () => Promise<T[]> | T[], deps: unknown[], cached: T[]): T[] {
  const live = useLiveQuery(queryFn, deps)
  return live ?? cached
}

function useSingletonStoreHook<T>(
  queryFn: () => Promise<T | undefined> | T | undefined,
  deps: unknown[],
  cached: T | undefined
): T | undefined {
  const live = useLiveQuery(queryFn, deps, cached)
  if (live === undefined && cached !== undefined) return cached
  return live
}

export function useWorkspaceFromStore(workspaceId: string | undefined): CachedWorkspace | undefined {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? cache.workspaces.get(workspaceId) : undefined
  return useSingletonStoreHook(() => (workspaceId ? db.workspaces.get(workspaceId) : undefined), [workspaceId], cached)
}

export function useWorkspaceUsers(workspaceId: string | undefined): CachedWorkspaceUser[] {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.users.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.workspaceUsers.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useWorkspaceStreams(workspaceId: string | undefined): CachedStream[] {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.streams.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.streams.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useWorkspaceStreamMemberships(workspaceId: string | undefined): CachedStreamMembership[] {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.memberships.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.streamMemberships.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useWorkspaceDmPeers(workspaceId: string | undefined): CachedDmPeer[] {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.dmPeers.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.dmPeers.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useWorkspacePersonas(workspaceId: string | undefined): CachedPersona[] {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.personas.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.personas.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useWorkspaceBots(workspaceId: string | undefined): CachedBot[] {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.bots.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.bots.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useWorkspaceLabels(workspaceId: string | undefined): CachedLabel[] {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.labels.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.labels.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useWorkspaceLabelMemberships(workspaceId: string | undefined): CachedLabelMembership[] {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.labelMemberships.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.labelMemberships.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useWorkspaceLabelAssignments(workspaceId: string | undefined): CachedLabelAssignment[] {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.labelAssignments.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.labelAssignments.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useWorkspaceUnreadState(workspaceId: string | undefined): CachedUnreadState | undefined {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? cache.unreadState.get(workspaceId) : undefined
  return useSingletonStoreHook(() => (workspaceId ? db.unreadState.get(workspaceId) : undefined), [workspaceId], cached)
}

export function useWorkspaceUserPreferences(workspaceId: string | undefined): CachedUserPreferences | undefined {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? cache.userPreferences.get(workspaceId) : undefined
  return useSingletonStoreHook(
    () => (workspaceId ? db.userPreferences.get(workspaceId) : undefined),
    [workspaceId],
    cached
  )
}

export function useWorkspaceSidebarConfig(workspaceId: string | undefined): CachedSidebarConfig | undefined {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? cache.sidebarConfig.get(workspaceId) : undefined
  return useSingletonStoreHook(
    () => (workspaceId ? db.sidebarConfigs.get(workspaceId) : undefined),
    [workspaceId],
    cached
  )
}

export function useWorkspaceMetadata(workspaceId: string | undefined): CachedWorkspaceMetadata | undefined {
  useWorkspaceCacheSignal(workspaceId)
  const cached = workspaceId ? cache.metadata.get(workspaceId) : undefined
  return useSingletonStoreHook(
    () => (workspaceId ? db.workspaceMetadata.get(workspaceId) : undefined),
    [workspaceId],
    cached
  )
}
