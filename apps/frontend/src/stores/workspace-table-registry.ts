import { liveQuery, type Subscription } from "dexie"
import { semanticEqual } from "@/sync/bootstrap-diff"
// Namespace import so a test can spy the facade against the module (INV-48).
import * as perfCapture from "@/lib/perf/capture"
import { createDbScopedRegistry } from "@/lib/db-scoped-registry"
import {
  type CachedBot,
  type CachedDmPeer,
  type CachedLabel,
  type CachedLabelAssignment,
  type CachedPersona,
  type CachedSidebarConfig,
  type CachedStream,
  type CachedStreamMembership,
  type CachedStreamReadState,
  type CachedUnreadState,
  type CachedUserPreferences,
  type CachedWorkspace,
  type CachedWorkspaceMetadata,
  type CachedWorkspaceUser,
  type ThreaDatabase,
} from "@/db"

/** The row type each table key resolves to (INV-31: the key union is derived from it). */
export interface WorkspaceTableRowTypes {
  users: CachedWorkspaceUser
  streams: CachedStream
  memberships: CachedStreamMembership
  readStates: CachedStreamReadState
  dmPeers: CachedDmPeer
  personas: CachedPersona
  bots: CachedBot
  labels: CachedLabel
  labelAssignments: CachedLabelAssignment
  workspace: CachedWorkspace
  unreadState: CachedUnreadState
  userPreferences: CachedUserPreferences
  sidebarConfig: CachedSidebarConfig
  metadata: CachedWorkspaceMetadata
}

export type WorkspaceTableKey = keyof WorkspaceTableRowTypes

interface IdentifiedRow {
  id: string
}

type TableQuery = (database: ThreaDatabase, workspaceId: string) => Promise<IdentifiedRow[]>

function oneRow<T extends IdentifiedRow>(row: T | undefined): T[] {
  return row ? [row] : []
}

// Every query takes the entry's OWN database rather than reading the shared
// `db` proxy: a liveQuery re-runs on any storage mutation, so a proxy read
// would re-execute a subscription opened by one account against whichever
// account is active when it fires.
const WORKSPACE_TABLE_QUERIES: Record<WorkspaceTableKey, TableQuery> = {
  users: (database, workspaceId) => database.workspaceUsers.where("workspaceId").equals(workspaceId).toArray(),
  streams: (database, workspaceId) => database.streams.where("workspaceId").equals(workspaceId).toArray(),
  memberships: (database, workspaceId) => database.streamMemberships.where("workspaceId").equals(workspaceId).toArray(),
  readStates: (database, workspaceId) => database.streamReadState.where("workspaceId").equals(workspaceId).toArray(),
  dmPeers: (database, workspaceId) => database.dmPeers.where("workspaceId").equals(workspaceId).toArray(),
  personas: (database, workspaceId) => database.personas.where("workspaceId").equals(workspaceId).toArray(),
  bots: (database, workspaceId) => database.bots.where("workspaceId").equals(workspaceId).toArray(),
  labels: (database, workspaceId) => database.labels.where("workspaceId").equals(workspaceId).toArray(),
  labelAssignments: (database, workspaceId) =>
    database.labelAssignments.where("workspaceId").equals(workspaceId).toArray(),
  workspace: async (database, workspaceId) => oneRow(await database.workspaces.get(workspaceId)),
  unreadState: async (database, workspaceId) => oneRow(await database.unreadState.get(workspaceId)),
  userPreferences: async (database, workspaceId) => oneRow(await database.userPreferences.get(workspaceId)),
  sidebarConfig: async (database, workspaceId) => oneRow(await database.sidebarConfigs.get(workspaceId)),
  metadata: async (database, workspaceId) => oneRow(await database.workspaceMetadata.get(workspaceId)),
}

interface WorkspaceTableEntry {
  workspaceId: string
  tableKey: WorkspaceTableKey
  rows: IdentifiedRow[] | undefined
  byId: Map<string, IdentifiedRow>
  resolved: boolean
  listeners: Set<() => void>
  keyListeners: Map<string, Set<() => void>>
  refCount: number
  subscription: Subscription
  teardown: ReturnType<typeof setTimeout> | null
}

// INV-9 exception, the same one `railRegistry`/`threadIndexRegistry` carry
// (`hooks/use-board-card-messages.ts`): one module-level `liveQuery` per
// (workspace, table), ref-counted across every consumer. `useWorkspaceUsers`
// alone has 40 call sites and each used to open its own whole-table
// subscription, so a rendered timeline opened ~50 identical reads of the same
// rows. A context provider would re-render its whole subtree on every table
// change — which is the cost this exists to remove.
//
// Scoped to the account database the entry read from. Two accounts can be
// members of one workspace, so (workspace, table) alone is a key they SHARE:
// the outgoing account's rows answered the incoming account's reads, and its
// teardown timer — armed for longer than the switch takes — fired against the
// replacement entry. Subscribers capture their (database, entry) pair and act
// on it directly, so nothing resolves a key a second time.
const registry = createDbScopedRegistry<WorkspaceTableEntry>()

// Matches `RAIL_TEARDOWN_GRACE_MS`: a remount unsubscribes before it
// re-subscribes, and tearing the query down in between would re-read the table.
const TABLE_TEARDOWN_GRACE_MS = 5_000

let lastMarkedLiveEntries = -1

/**
 * Rows compare on every own key, `_cachedAt` included: a caller reading
 * freshness off a row must not be handed an object whose stamp is older than
 * IDB's. Unchanged rows keep their stamp (the bootstrap diff skips them), so
 * identity still survives the writes that matter.
 */
const COMPARE_ALL_KEYS: ReadonlySet<string> = new Set()

function entryKeyFor(workspaceId: string, tableKey: WorkspaceTableKey): string {
  return `${workspaceId}|${tableKey}`
}

function applyEmission(entry: WorkspaceTableEntry, incoming: IdentifiedRow[]): void {
  const previous = entry.rows
  const byId = new Map<string, IdentifiedRow>()
  const changedIds: string[] = []
  let changed = previous === undefined || previous.length !== incoming.length
  const next = incoming.map((row, index) => {
    const prior = entry.byId.get(row.id)
    if (prior && semanticEqual(prior, row, COMPARE_ALL_KEYS)) {
      byId.set(row.id, prior)
      if (previous?.[index] !== prior) changed = true
      return prior
    }
    byId.set(row.id, row)
    changedIds.push(row.id)
    changed = true
    return row
  })
  for (const id of entry.byId.keys()) {
    if (!byId.has(id)) {
      changedIds.push(id)
      changed = true
    }
  }

  const wasResolved = entry.resolved
  entry.byId = byId
  entry.resolved = true
  // A snapshot reference that survives an emission is what keeps array
  // consumers from re-rendering when nothing they read changed.
  if (changed) entry.rows = next

  if (changed || !wasResolved) {
    for (const notify of entry.listeners) notify()
  }
  for (const id of changedIds) {
    const keyed = entry.keyListeners.get(id)
    if (!keyed) continue
    for (const notify of keyed) notify()
  }
}

/** Entries holding a Dexie subscription that is not already scheduled for teardown. */
function liveEntryCount(): number {
  let count = 0
  for (const entry of registry.all()) {
    if (!entry.teardown) count += 1
  }
  return count
}

function markLiveEntries(): void {
  const count = liveEntryCount()
  if (count === lastMarkedLiveEntries) return
  lastMarkedLiveEntries = count
  perfCapture.getPerfCapture().mark("store.tableSubscriptions", count)
}

interface HeldEntry {
  database: ThreaDatabase
  entry: WorkspaceTableEntry
  entryKey: string
}

function ensureEntry(workspaceId: string, tableKey: WorkspaceTableKey): HeldEntry {
  const entryKey = entryKeyFor(workspaceId, tableKey)
  const { database, entry, isNew } = registry.acquire(entryKey, () => ({
    workspaceId,
    tableKey,
    rows: undefined,
    byId: new Map(),
    resolved: false,
    listeners: new Set<() => void>(),
    keyListeners: new Map(),
    refCount: 0,
    subscription: { unsubscribe() {} } as Subscription,
    teardown: null,
  }))
  if (isNew) {
    entry.subscription = liveQuery(() => WORKSPACE_TABLE_QUERIES[tableKey](database, workspaceId)).subscribe((rows) => {
      // The captured entry, checked against the registry: an emission that
      // arrives after this entry was torn down (or after its account was
      // replaced) has nowhere to land.
      if (!registry.holds(database, entryKey, entry)) return
      applyEmission(entry, rows)
    })
    markLiveEntries()
  } else if (entry.teardown) {
    clearTimeout(entry.teardown)
    entry.teardown = null
    markLiveEntries()
  }
  return { database, entry, entryKey }
}

function releaseEntry({ database, entry, entryKey }: HeldEntry): void {
  if (entry.refCount > 0 || entry.listeners.size > 0 || entry.keyListeners.size > 0) return
  if (entry.teardown) return
  entry.teardown = setTimeout(() => {
    if (entry.refCount > 0 || entry.listeners.size > 0 || entry.keyListeners.size > 0) return
    entry.subscription.unsubscribe()
    registry.remove(database, entryKey, entry)
    markLiveEntries()
  }, TABLE_TEARDOWN_GRACE_MS)
  markLiveEntries()
}

/** Subscribe one consumer to a workspace table. */
export function subscribeWorkspaceTable(
  workspaceId: string,
  tableKey: WorkspaceTableKey,
  listener: () => void
): () => void {
  const held = ensureEntry(workspaceId, tableKey)
  const { entry } = held
  entry.listeners.add(listener)
  entry.refCount += 1

  let released = false
  return () => {
    if (released) return
    released = true
    entry.listeners.delete(listener)
    entry.refCount -= 1
    if (entry.refCount <= 0) releaseEntry(held)
  }
}

/** Subscribe to one row of a table, so a change to row X wakes only X's readers (D6). */
export function subscribeWorkspaceTableRow(
  workspaceId: string,
  tableKey: WorkspaceTableKey,
  rowId: string,
  listener: () => void
): () => void {
  const held = ensureEntry(workspaceId, tableKey)
  const { entry } = held
  let keyed = entry.keyListeners.get(rowId)
  if (!keyed) {
    keyed = new Set()
    entry.keyListeners.set(rowId, keyed)
  }
  keyed.add(listener)
  entry.refCount += 1

  let released = false
  return () => {
    if (released) return
    released = true
    const set = entry.keyListeners.get(rowId)
    if (set) {
      set.delete(listener)
      if (set.size === 0) entry.keyListeners.delete(rowId)
    }
    entry.refCount -= 1
    if (entry.refCount <= 0) releaseEntry(held)
  }
}

/** The table's rows, or `undefined` while the first read is in flight (`useLiveQuery`'s contract). */
export function getWorkspaceTableSnapshot<K extends WorkspaceTableKey>(
  workspaceId: string,
  tableKey: K
): WorkspaceTableRowTypes[K][] | undefined {
  const entry = registry.peek(entryKeyFor(workspaceId, tableKey))
  return entry?.rows as WorkspaceTableRowTypes[K][] | undefined
}

export function getWorkspaceTableRow<K extends WorkspaceTableKey>(
  workspaceId: string,
  tableKey: K,
  rowId: string
): WorkspaceTableRowTypes[K] | undefined {
  const entry = registry.peek(entryKeyFor(workspaceId, tableKey))
  return entry?.byId.get(rowId) as WorkspaceTableRowTypes[K] | undefined
}

/**
 * The workspace whose entry currently holds `rowId`, or `undefined`.
 *
 * For consumers that know a row id but not its workspace (`useStreamFromStore`).
 */
export function findSharedRowWorkspace(tableKey: WorkspaceTableKey, rowId: string): string | undefined {
  // The ACTIVE account's entries only: another account's cached row must never
  // answer "which workspace owns this stream" for this one.
  for (const [, entry] of registry.activeEntries()) {
    if (entry.tableKey !== tableKey) continue
    if (entry.byId.has(rowId)) return entry.workspaceId
  }
  return undefined
}

/**
 * True when the (workspace, table) entry is live and has resolved.
 *
 * Lets a reader tell a row's genuine removal — that entry still answering, just
 * without the id — from a teardown, where the row is unchanged and only the
 * reader's route to it went away.
 */
export function hasResolvedSharedEntry(workspaceId: string, tableKey: WorkspaceTableKey): boolean {
  const entry = registry.peek(entryKeyFor(workspaceId, tableKey))
  return Boolean(entry?.resolved && !entry.teardown)
}

/** Live Dexie subscriptions on workspace tables, teardown-grace ones included. */
export function activeWorkspaceSubscriptionCount(): number {
  return registry.size()
}

export function resetWorkspaceTableRegistry(): void {
  for (const entry of registry.all()) {
    if (entry.teardown) clearTimeout(entry.teardown)
    entry.subscription.unsubscribe()
  }
  registry.clear()
  lastMarkedLiveEntries = -1
}
