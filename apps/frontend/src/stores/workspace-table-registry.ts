import { liveQuery, type Subscription } from "dexie"
import { semanticEqual } from "@/sync/bootstrap-diff"
// Namespace import so a test can spy the facade against the module (INV-48).
import * as perfCapture from "@/lib/perf/capture"
import {
  db,
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

type TableQuery = (workspaceId: string) => Promise<IdentifiedRow[]>

function oneRow<T extends IdentifiedRow>(row: T | undefined): T[] {
  return row ? [row] : []
}

const WORKSPACE_TABLE_QUERIES: Record<WorkspaceTableKey, TableQuery> = {
  users: (workspaceId) => db.workspaceUsers.where("workspaceId").equals(workspaceId).toArray(),
  streams: (workspaceId) => db.streams.where("workspaceId").equals(workspaceId).toArray(),
  memberships: (workspaceId) => db.streamMemberships.where("workspaceId").equals(workspaceId).toArray(),
  readStates: (workspaceId) => db.streamReadState.where("workspaceId").equals(workspaceId).toArray(),
  dmPeers: (workspaceId) => db.dmPeers.where("workspaceId").equals(workspaceId).toArray(),
  personas: (workspaceId) => db.personas.where("workspaceId").equals(workspaceId).toArray(),
  bots: (workspaceId) => db.bots.where("workspaceId").equals(workspaceId).toArray(),
  labels: (workspaceId) => db.labels.where("workspaceId").equals(workspaceId).toArray(),
  labelAssignments: (workspaceId) => db.labelAssignments.where("workspaceId").equals(workspaceId).toArray(),
  workspace: async (workspaceId) => oneRow(await db.workspaces.get(workspaceId)),
  unreadState: async (workspaceId) => oneRow(await db.unreadState.get(workspaceId)),
  userPreferences: async (workspaceId) => oneRow(await db.userPreferences.get(workspaceId)),
  sidebarConfig: async (workspaceId) => oneRow(await db.sidebarConfigs.get(workspaceId)),
  metadata: async (workspaceId) => oneRow(await db.workspaceMetadata.get(workspaceId)),
}

interface WorkspaceTableEntry {
  workspaceId: string
  tableKey: WorkspaceTableKey
  rows: IdentifiedRow[] | undefined
  byId: Map<string, IdentifiedRow>
  resolved: boolean
  emissionSeq: number
  listeners: Set<() => void>
  keyListeners: Map<string, Set<() => void>>
  refCount: number
  subscription: Subscription
  teardown: ReturnType<typeof setTimeout> | null
}

interface RegistrationBase {
  workspaceId: string
  tableKey: WorkspaceTableKey
  listener: () => void
  entryKey: string
}

type Registration = (RegistrationBase & { kind: "table" }) | (RegistrationBase & { kind: "row"; rowId: string })

// INV-9 exception, the same one `railRegistry`/`threadIndexRegistry` carry
// (`hooks/use-board-card-messages.ts`): one module-level `liveQuery` per
// (workspace, table), ref-counted across every consumer. `useWorkspaceUsers`
// alone has 40 call sites and each used to open its own whole-table
// subscription, so a rendered timeline opened ~50 identical reads of the same
// rows. A context provider would re-render its whole subtree on every table
// change — which is the cost this exists to remove.
const entries = new Map<string, WorkspaceTableEntry>()
// Keyed by an internal registration id: one consumer can hold several
// registrations, and `unsubscribe` must resolve ITS entry here at call time.
const registrations = new Map<number, Registration>()

// Matches `RAIL_TEARDOWN_GRACE_MS`: a remount unsubscribes before it
// re-subscribes, and tearing the query down in between would re-read the table.
const TABLE_TEARDOWN_GRACE_MS = 5_000

let nextRegistrationId = 1
let lastMarkedLiveEntries = -1

/**
 * Rows compare on every own key, `_cachedAt` included: a caller reading
 * freshness off a row must not be handed an object whose stamp is older than
 * IDB's. Unchanged rows keep their stamp (the bootstrap diff skips them), so
 * identity still survives the writes that matter.
 */
const COMPARE_ALL_KEYS: ReadonlySet<string> = new Set()

let emissionCounter = 0

function entryKeyFor(workspaceId: string, tableKey: WorkspaceTableKey): string {
  return `${workspaceId}|${tableKey}`
}

function applyEmission(entryKey: string, incoming: IdentifiedRow[]): void {
  const entry = entries.get(entryKey)
  if (!entry) return

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
  entry.emissionSeq = ++emissionCounter
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
  for (const entry of entries.values()) {
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

function ensureEntry(entryKey: string, workspaceId: string, tableKey: WorkspaceTableKey): WorkspaceTableEntry {
  const existing = entries.get(entryKey)
  if (existing) {
    if (existing.teardown) {
      clearTimeout(existing.teardown)
      existing.teardown = null
      markLiveEntries()
    }
    return existing
  }

  const created: WorkspaceTableEntry = {
    workspaceId,
    tableKey,
    rows: undefined,
    byId: new Map(),
    resolved: false,
    emissionSeq: 0,
    listeners: new Set(),
    keyListeners: new Map(),
    refCount: 0,
    subscription: { unsubscribe() {} } as Subscription,
    teardown: null,
  }
  // Register BEFORE subscribing so a synchronous first emission finds the entry;
  // the callback re-reads it from the map, so a late emission after teardown is
  // a no-op.
  entries.set(entryKey, created)
  created.subscription = liveQuery(() => WORKSPACE_TABLE_QUERIES[tableKey](workspaceId)).subscribe((rows) =>
    applyEmission(entryKey, rows)
  )
  markLiveEntries()
  return created
}

function releaseEntry(entryKey: string): void {
  const entry = entries.get(entryKey)
  if (!entry) return
  if (entry.refCount > 0 || entry.listeners.size > 0 || entry.keyListeners.size > 0) return
  if (entry.teardown) return
  entry.teardown = setTimeout(() => {
    const live = entries.get(entryKey)
    if (!live || live.refCount > 0 || live.listeners.size > 0 || live.keyListeners.size > 0) return
    live.subscription.unsubscribe()
    entries.delete(entryKey)
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
  const entryKey = entryKeyFor(workspaceId, tableKey)
  const entry = ensureEntry(entryKey, workspaceId, tableKey)
  entry.listeners.add(listener)
  entry.refCount += 1
  const registrationId = nextRegistrationId++
  registrations.set(registrationId, { kind: "table", workspaceId, tableKey, listener, entryKey })

  return () => {
    const registration = registrations.get(registrationId)
    if (!registration) return
    registrations.delete(registrationId)
    const current = entries.get(registration.entryKey)
    if (!current) return
    current.listeners.delete(listener)
    current.refCount -= 1
    if (current.refCount <= 0) releaseEntry(registration.entryKey)
  }
}

/** Subscribe to one row of a table, so a change to row X wakes only X's readers (D6). */
export function subscribeWorkspaceTableRow(
  workspaceId: string,
  tableKey: WorkspaceTableKey,
  rowId: string,
  listener: () => void
): () => void {
  const entryKey = entryKeyFor(workspaceId, tableKey)
  const entry = ensureEntry(entryKey, workspaceId, tableKey)
  let keyed = entry.keyListeners.get(rowId)
  if (!keyed) {
    keyed = new Set()
    entry.keyListeners.set(rowId, keyed)
  }
  keyed.add(listener)
  entry.refCount += 1
  const registrationId = nextRegistrationId++
  registrations.set(registrationId, { kind: "row", workspaceId, tableKey, rowId, listener, entryKey })

  return () => {
    const registration = registrations.get(registrationId)
    if (!registration) return
    registrations.delete(registrationId)
    const current = entries.get(registration.entryKey)
    if (!current) return
    const set = current.keyListeners.get(rowId)
    if (set) {
      set.delete(listener)
      if (set.size === 0) current.keyListeners.delete(rowId)
    }
    current.refCount -= 1
    if (current.refCount <= 0) releaseEntry(registration.entryKey)
  }
}

/** The table's rows, or `undefined` while the first read is in flight (`useLiveQuery`'s contract). */
export function getWorkspaceTableSnapshot<K extends WorkspaceTableKey>(
  workspaceId: string,
  tableKey: K
): WorkspaceTableRowTypes[K][] | undefined {
  const entry = entries.get(entryKeyFor(workspaceId, tableKey))
  return entry?.rows as WorkspaceTableRowTypes[K][] | undefined
}

export function getWorkspaceTableRow<K extends WorkspaceTableKey>(
  workspaceId: string,
  tableKey: K,
  rowId: string
): WorkspaceTableRowTypes[K] | undefined {
  const entry = entries.get(entryKeyFor(workspaceId, tableKey))
  return entry?.byId.get(rowId) as WorkspaceTableRowTypes[K] | undefined
}

/**
 * The workspace whose entry currently holds `rowId`, or `undefined`.
 *
 * For consumers that know a row id but not its workspace (`useStreamFromStore`).
 */
export function findSharedRowWorkspace(tableKey: WorkspaceTableKey, rowId: string): string | undefined {
  for (const entry of entries.values()) {
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
  const entry = entries.get(entryKeyFor(workspaceId, tableKey))
  return Boolean(entry?.resolved && !entry.teardown)
}

/** Live Dexie subscriptions on workspace tables, teardown-grace ones included. */
export function activeWorkspaceSubscriptionCount(): number {
  return entries.size
}

export function resetWorkspaceTableRegistry(): void {
  for (const entry of entries.values()) {
    if (entry.teardown) clearTimeout(entry.teardown)
    entry.subscription.unsubscribe()
  }
  entries.clear()
  registrations.clear()
  lastMarkedLiveEntries = -1
}
