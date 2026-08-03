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

/** `shared` = one live query per (workspace, table); `off` = one per subscriber, as before the registry. */
export type WorkspaceReadMode = "shared" | "off"

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
  token: number
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
// Keyed by an internal registration id, not by the consumer token: one token can
// hold several registrations, and `unsubscribe` must resolve ITS entry key here
// at call time — a captured key goes stale the moment a mode flip re-keys it,
// which leaks the listener and pins `refCount` for the session.
const registrations = new Map<number, Registration>()

// Matches `RAIL_TEARDOWN_GRACE_MS`: a remount unsubscribes before it
// re-subscribes, and tearing the query down in between would re-read the table.
const TABLE_TEARDOWN_GRACE_MS = 5_000

let mode: WorkspaceReadMode = "off"
let nextToken = 1
let nextRegistrationId = 1
let lastMarkedLiveEntries = -1

/**
 * Rows compare on every own key, `_cachedAt` included: a caller reading
 * freshness off a row must not be handed an object whose stamp is older than
 * IDB's. Unchanged rows keep their stamp (the bootstrap diff skips them), so
 * identity still survives the writes that matter.
 */
const COMPARE_ALL_KEYS: ReadonlySet<string> = new Set()

/** A stable token for one consumer, so the `off` mode can key a private entry per subscriber. */
export function allocateWorkspaceTableToken(): number {
  return nextToken++
}

let emissionCounter = 0

function entryKeyFor(workspaceId: string, tableKey: WorkspaceTableKey, token: number): string {
  return mode === "shared" ? `${workspaceId}|${tableKey}` : `${workspaceId}|${tableKey}|${token}`
}

function applyEmission(entryKey: string, incoming: IdentifiedRow[]): void {
  const entry = entries.get(entryKey)
  if (!entry) return

  // Private (token-keyed) entries have exactly one consumer and match the
  // pre-registry useLiveQuery behaviour: fresh rows, notify on every emission.
  // The per-row semantic compare would be pure added cost there — for the
  // metadata singleton it deep-walks the ~356KB emoji row once per consumer
  // per reaction, and the rows genuinely changed so everyone re-renders anyway.
  if (entryKey.split("|").length === 3) {
    entry.byId = new Map(incoming.map((row) => [row.id, row]))
    entry.rows = incoming
    entry.resolved = true
    entry.emissionSeq = ++emissionCounter
    for (const notify of entry.listeners) notify()
    for (const keyed of entry.keyListeners.values()) {
      for (const notify of keyed) notify()
    }
    return
  }

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
  // The mark measures the shared-arm subscription economy. In `off` mode the
  // count tracks consumer mounts (~700 per window) — emitting it would flood
  // the 2000-sample capture ring and evict the marks the A/B compares, and
  // liveEntryCount() itself is O(entries) on a hot path.
  if (mode !== "shared") return
  const count = liveEntryCount()
  if (count === lastMarkedLiveEntries) return
  lastMarkedLiveEntries = count
  perfCapture.getPerfCapture().mark("store.tableSubscriptions", count)
}

function ensureEntry(
  entryKey: string,
  workspaceId: string,
  tableKey: WorkspaceTableKey,
  seed?: WorkspaceTableEntry
): WorkspaceTableEntry {
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
  if (seed?.resolved) {
    created.rows = seed.rows
    created.byId = new Map(seed.byId)
    created.resolved = true
    created.emissionSeq = seed.emissionSeq
  }
  entries.set(entryKey, created)
  created.subscription = liveQuery(() => WORKSPACE_TABLE_QUERIES[tableKey](workspaceId)).subscribe((rows) =>
    applyEmission(entryKey, rows)
  )
  markLiveEntries()
  return created
}

function releaseEntry(entryKey: string, immediate: boolean): void {
  const entry = entries.get(entryKey)
  if (!entry) return
  if (entry.refCount > 0 || entry.listeners.size > 0 || entry.keyListeners.size > 0) return
  // Private (token-keyed) entries tear down immediately: their one consumer is
  // gone, nobody else can adopt them, and the grace window would keep a
  // whole-table liveQuery re-reading for 5s per unmounted consumer — a
  // behaviour change vs the pre-registry useLiveQuery cleanup in the arm every
  // user ships with. A StrictMode remount just re-creates the private query.
  if (immediate) {
    if (entry.teardown) clearTimeout(entry.teardown)
    entry.subscription.unsubscribe()
    entries.delete(entryKey)
    markLiveEntries()
    return
  }
  if (entry.teardown) return
  // Private (token-keyed) entries get a zero-delay grace: their one consumer is
  // gone and nobody else can adopt them, so the 5s window would keep a
  // whole-table liveQuery re-reading per unmounted consumer — a behaviour
  // change vs the pre-registry useLiveQuery cleanup in the default arm. Zero
  // delay still absorbs a same-task unsubscribe/resubscribe (StrictMode
  // remount): the callback re-checks liveness and aborts.
  const graceMs = entryKey.split("|").length === 3 ? 0 : TABLE_TEARDOWN_GRACE_MS
  entry.teardown = setTimeout(() => {
    const live = entries.get(entryKey)
    if (!live || live.refCount > 0 || live.listeners.size > 0 || live.keyListeners.size > 0) return
    live.subscription.unsubscribe()
    entries.delete(entryKey)
    markLiveEntries()
  }, graceMs)
  markLiveEntries()
}

/**
 * Subscribe one consumer to a workspace table. `token` comes from
 * {@link allocateWorkspaceTableToken} and must be stable for the consumer's
 * lifetime — in `off` mode it is what keeps the subscription private.
 */
export function subscribeWorkspaceTable(
  workspaceId: string,
  tableKey: WorkspaceTableKey,
  token: number,
  listener: () => void
): () => void {
  const entryKey = entryKeyFor(workspaceId, tableKey, token)
  const entry = ensureEntry(entryKey, workspaceId, tableKey)
  entry.listeners.add(listener)
  entry.refCount += 1
  const registrationId = nextRegistrationId++
  registrations.set(registrationId, { kind: "table", workspaceId, tableKey, token, listener, entryKey })

  return () => {
    const registration = registrations.get(registrationId)
    if (!registration) return
    registrations.delete(registrationId)
    const current = entries.get(registration.entryKey)
    if (!current) return
    current.listeners.delete(listener)
    current.refCount -= 1
    if (current.refCount <= 0) releaseEntry(registration.entryKey, false)
  }
}

/** Subscribe to one row of a shared table, so a change to row X wakes only X's readers (D6). */
export function subscribeWorkspaceTableRow(
  workspaceId: string,
  tableKey: WorkspaceTableKey,
  rowId: string,
  token: number,
  listener: () => void
): () => void {
  const entryKey = entryKeyFor(workspaceId, tableKey, token)
  const entry = ensureEntry(entryKey, workspaceId, tableKey)
  let keyed = entry.keyListeners.get(rowId)
  if (!keyed) {
    keyed = new Set()
    entry.keyListeners.set(rowId, keyed)
  }
  keyed.add(listener)
  entry.refCount += 1
  const registrationId = nextRegistrationId++
  registrations.set(registrationId, { kind: "row", workspaceId, tableKey, rowId, token, listener, entryKey })

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
    if (current.refCount <= 0) releaseEntry(registration.entryKey, false)
  }
}

/** The table's rows, or `undefined` while the first read is in flight (`useLiveQuery`'s contract). */
export function getWorkspaceTableSnapshot<K extends WorkspaceTableKey>(
  workspaceId: string,
  tableKey: K,
  token: number
): WorkspaceTableRowTypes[K][] | undefined {
  const entry = entries.get(entryKeyFor(workspaceId, tableKey, token))
  return entry?.rows as WorkspaceTableRowTypes[K][] | undefined
}

export function getWorkspaceTableRow<K extends WorkspaceTableKey>(
  workspaceId: string,
  tableKey: K,
  rowId: string,
  token: number
): WorkspaceTableRowTypes[K] | undefined {
  const entry = entries.get(entryKeyFor(workspaceId, tableKey, token))
  return entry?.byId.get(rowId) as WorkspaceTableRowTypes[K] | undefined
}

function detach(entry: WorkspaceTableEntry, registration: Registration): void {
  if (registration.kind === "table") {
    entry.listeners.delete(registration.listener)
  } else {
    const set = entry.keyListeners.get(registration.rowId)
    if (set) {
      set.delete(registration.listener)
      if (set.size === 0) entry.keyListeners.delete(registration.rowId)
    }
  }
  entry.refCount -= 1
}

function attach(entry: WorkspaceTableEntry, registration: Registration): void {
  if (registration.kind === "table") {
    entry.listeners.add(registration.listener)
  } else {
    let keyed = entry.keyListeners.get(registration.rowId)
    if (!keyed) {
      keyed = new Set()
      entry.keyListeners.set(registration.rowId, keyed)
    }
    keyed.add(registration.listener)
  }
  entry.refCount += 1
}

function visibleSnapshot(entry: WorkspaceTableEntry | undefined, registration: Registration): unknown {
  if (!entry) return undefined
  return registration.kind === "table" ? entry.rows : entry.byId.get(registration.rowId)
}

/**
 * Flip sharing on or off. Every live registration — array and row alike — is
 * moved to its new entry key synchronously, so the flag can arrive or change
 * mid-session without a single hook count changing (D5).
 *
 * The new entry is seeded from the most recently emitted resolved predecessor
 * for the same (workspace, table): the query is identical, but private entries
 * emit independently, so an older resolved snapshot can still be sitting in the
 * map and would republish rolled-back rows. Publishing an unresolved entry instead would regress every consumer
 * to its bootstrap-era cache fallback for a frame — and the flag itself is read
 * through this registry, so an unresolved metadata entry would flip the mode back
 * and loop.
 */
export function setWorkspaceReadMode(next: WorkspaceReadMode): void {
  if (next === mode) return
  const active = [...registrations.entries()]
  const before = new Map<number, unknown>()
  const seeds = new Map<string, WorkspaceTableEntry>()

  for (const [id, registration] of active) {
    const entry = entries.get(registration.entryKey)
    before.set(id, visibleSnapshot(entry, registration))
    if (!entry) continue
    detach(entry, registration)
  }
  for (const entry of entries.values()) {
    const seedKey = `${entry.workspaceId}|${entry.tableKey}`
    if (!entry.resolved) continue
    const held = seeds.get(seedKey)
    if (!held || entry.emissionSeq > held.emissionSeq) seeds.set(seedKey, entry)
  }

  mode = next

  for (const [id, registration] of active) {
    const entryKey = entryKeyFor(registration.workspaceId, registration.tableKey, registration.token)
    const entry = ensureEntry(
      entryKey,
      registration.workspaceId,
      registration.tableKey,
      seeds.get(`${registration.workspaceId}|${registration.tableKey}`)
    )
    attach(entry, registration)
    registrations.set(id, { ...registration, entryKey })
  }
  for (const [, registration] of active) releaseEntry(registration.entryKey, true)

  for (const [id] of active) {
    const current = registrations.get(id)
    if (!current) continue
    if (visibleSnapshot(entries.get(current.entryKey), current) !== before.get(id)) current.listener()
  }
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
  mode = "off"
  lastMarkedLiveEntries = -1
}
