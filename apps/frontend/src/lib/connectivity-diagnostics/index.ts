import Dexie, { type EntityTable } from "dexie"
import { currentAppVersion } from "@/lib/app-build"
import { createDiagnosticId, registerConnectivityDiagnosticsRuntime } from "./facade"
import {
  cacheConnectivityAuthorization,
  clearConnectivityConsentTombstone,
  isConnectivityConsentTombstoned,
  readCachedConnectivityAuthorization,
  readPendingConnectivityRevocations,
  tombstoneConnectivityAuthorization,
  type AuthorizedConnectivityDiagnosticsConfig,
  type ConnectivityDiagnosticsConfig,
} from "./consent-cache"

export type { ConnectivityDiagnosticsConfig } from "./consent-cache"
export {
  categorizeRoom,
  categorizeRoute,
  createDiagnosticId,
  getSocketDiagnosticContext,
  setSocketDiagnosticContext,
} from "./facade"

export type ConnectivityEvent =
  | "http_start"
  | "http_upload_complete"
  | "http_headers"
  | "http_body_complete"
  | "http_failure"
  | "http_abort"
  | "http_timeout"
  | "http_stalled"
  | "socket_connect"
  | "socket_error"
  | "socket_disconnect"
  | "socket_reconnect_start"
  | "socket_reconnect_error"
  | "socket_reconnect_exhausted"
  | "room_join_start"
  | "room_join_ack"
  | "room_join_failure"
  | "room_join_abort"
  | "room_join_connection_wait"
  | "message_queue_blocked"
  | "message_queue_unblocked"

export type RouteCategory =
  | "workspace_config"
  | "messages"
  | "streams"
  | "sync"
  | "attachments"
  | "avatars"
  | "agent_trace"
  | "other"
export type RoomCategory = "workspace" | "stream" | "agent_session" | "other"
export type ReasonClass = "network" | "timeout" | "abort" | "server" | "transport" | "unknown"

export interface DiagnosticFields {
  operationId?: string
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  route?: RouteCategory
  room?: RoomCategory
  transport?: "fetch" | "xhr"
  status?: number
  correlationId?: string
  connectionId?: string
  generation?: number
  attempt?: number
  reason?: ReasonClass
  blockedBy?: "socket" | "in_flight" | "lock"
}

interface DiagnosticRow extends DiagnosticFields {
  id: string
  scope: string
  event: ConnectivityEvent
  bootId: string
  browserSessionId: string
  appVersion: string
  wallTime: string
  monotonicMs: number
  createdAt: number
  byteSize: number
  consentEpoch: number
}

interface ConsentRow {
  scope: string
  epoch: number
  active: 0 | 1
  consentId: string
  updatedAt: number
}

interface DiagnosticsDb extends Dexie {
  events: EntityTable<DiagnosticRow, "id">
  consent: EntityTable<ConsentRow, "scope">
}

const MAX_ROWS = 500
const MAX_BYTES = 256 * 1024
const MAX_MEMORY_ROWS = 100
const MAX_MEMORY_BYTES = 64 * 1024
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const FLUSH_INTERVAL_MS = 30_000
const MIN_TRIGGER_FLUSH_MS = 5_000
const STALL_MS = 5_000
const NETWORK_TIMEOUT_MS = 10_000
const MAX_STALL_TIMERS = 100
const MAX_CONSENT_ROWS = 100
const RETRY_BASE_MS = 1_000
const MAX_RETRY_MS = 30_000
const DELIVERY_BATCH_SIZE = 50
let networkTimeoutMs = NETWORK_TIMEOUT_MS
let retryBaseMs = RETRY_BASE_MS

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const bootId = createDiagnosticId()
const browserSessionId = (() => {
  try {
    const existing = sessionStorage.getItem("threa:diagnostics-session")
    if (existing && UUID_PATTERN.test(existing)) return existing
    const created = createDiagnosticId()
    sessionStorage.setItem("threa:diagnostics-session", created)
    return created
  } catch {
    return createDiagnosticId()
  }
})()

function projectKey(value: ConnectivityDiagnosticsConfig): string {
  let hash = 2166136261
  for (const char of `${value.host}|${value.token}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(36)
}

const scopeOf = (value: ConnectivityDiagnosticsConfig) =>
  `${value.userId}:${value.workspaceId}:${value.region}:${projectKey(value)}`
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

let db: DiagnosticsDb | null = null

async function deleteExpiredRows(database: DiagnosticsDb): Promise<void> {
  await database.events
    .where("createdAt")
    .below(Date.now() - MAX_AGE_MS)
    .delete()
}

function getDb(): DiagnosticsDb {
  if (db) return db
  const created = new Dexie("threa-connectivity-diagnostics") as DiagnosticsDb
  created.version(1).stores({ events: "id, scope, createdAt", consent: "scope" })
  created.on("ready", () => deleteExpiredRows(created), true)
  db = created
  return created
}

interface Runtime {
  config: AuthorizedConnectivityDiagnosticsConfig
  scope: string
  epoch: number | null
  generation: number
  status: "initializing" | "ready" | "retry_wait"
  ready: Promise<boolean>
  resolveReady: (ready: boolean) => void
  initRequested: boolean
  initFailures: number
  nextInitAt: number
}

interface PendingRow {
  row: DiagnosticRow
  consentId: string
}

interface RevocationRequest {
  scope: string
  consentId: string
  failures: number
  nextAttemptAt: number
}

let runtime: Runtime | null = null
let generation = 0
let pending: PendingRow[] = []
let pendingBytes = 0
let persistenceRequested = false
let persistenceFailures = 0
let persistenceNextAttemptAt = 0
let maintenanceRequested = false
let maintenanceFailures = 0
let maintenanceNextAttemptAt = 0
const revocations = new Map<string, RevocationRequest>()
let storageTask: Promise<void> | null = null
let storageWakeTimer: ReturnType<typeof setTimeout> | null = null
let flushState: { generation: number; promise: Promise<boolean> } | null = null
let uploadController: AbortController | null = null
let interval: ReturnType<typeof setInterval> | null = null
let channel: BroadcastChannel | null = null
let lastTriggeredFlush = 0
const stallTimers = new Set<ReturnType<typeof setTimeout>>()

function deferredReady(): Pick<Runtime, "ready" | "resolveReady"> {
  let settled = false
  let resolvePromise!: (ready: boolean) => void
  const ready = new Promise<boolean>((resolve) => {
    resolvePromise = resolve
  })
  return {
    ready,
    resolveReady(value) {
      if (settled) return
      settled = true
      resolvePromise(value)
    },
  }
}

function retryDelay(failures: number): number {
  return Math.min(MAX_RETRY_MS, retryBaseMs * 2 ** Math.min(Math.max(failures - 1, 0), 5))
}

function removePendingScope(scope: string): void {
  pending = pending.filter(({ row }) => row.scope !== scope)
  pendingBytes = pending.reduce((sum, item) => sum + item.row.byteSize, 0)
}

function removePendingScopes(scopes: Set<string>): void {
  if (!scopes.size) return
  pending = pending.filter(({ row }) => !scopes.has(row.scope))
  pendingBytes = pending.reduce((sum, item) => sum + item.row.byteSize, 0)
}

function closeRuntimeResources(): void {
  if (interval) clearInterval(interval)
  interval = null
  window.removeEventListener("online", onlineFlush)
  uploadController?.abort()
  uploadController = null
  for (const timer of stallTimers) clearTimeout(timer)
  stallTimers.clear()
  channel?.close()
  channel = null
}

function openChannel(): void {
  if (typeof BroadcastChannel === "undefined") return
  try {
    channel = new BroadcastChannel("threa-connectivity-diagnostics")
  } catch {
    return
  }
  channel.addEventListener("message", (message: MessageEvent<unknown>) => {
    const data = message.data as { revokedScope?: unknown; consentId?: unknown } | null
    if (!data || typeof data.revokedScope !== "string") return
    if (runtime?.scope === data.revokedScope) suspendConnectivityDiagnostics()
    removePendingScope(data.revokedScope)
  })
}

function sameRuntimeConfig(current: Runtime, next: AuthorizedConnectivityDiagnosticsConfig): boolean {
  return (
    current.scope === scopeOf(next) &&
    current.config.accountId === next.accountId &&
    current.config.consentId === next.consentId &&
    current.config.host === next.host &&
    current.config.token === next.token
  )
}

function configureAuthorizedConnectivityDiagnostics(next: AuthorizedConnectivityDiagnosticsConfig): boolean {
  if (isConnectivityConsentTombstoned(next.consentId)) return false
  if (runtime && sameRuntimeConfig(runtime, next)) return true

  const previous = runtime
  previous?.resolveReady(false)
  closeRuntimeResources()

  const ready = deferredReady()
  const configured: Runtime = {
    config: next,
    scope: scopeOf(next),
    epoch: null,
    generation: ++generation,
    status: "initializing",
    ready: ready.ready,
    resolveReady: ready.resolveReady,
    initRequested: true,
    initFailures: 0,
    nextInitAt: 0,
  }
  runtime = configured
  openChannel()
  interval = setInterval(() => void flushConnectivityDiagnostics(), FLUSH_INTERVAL_MS)
  window.addEventListener("online", onlineFlush)
  pumpStorage()
  return true
}

export function authorizeConnectivityDiagnostics(
  accountId: string,
  config: ConnectivityDiagnosticsConfig,
  decisionVersion: string
): void {
  const authorized = cacheConnectivityAuthorization(accountId, config, decisionVersion, createDiagnosticId)
  if (authorized) configureAuthorizedConnectivityDiagnostics(authorized)
  else suspendConnectivityDiagnostics()
}

export function restoreConnectivityDiagnostics(accountId: string, workspaceId: string): boolean {
  const cached = readCachedConnectivityAuthorization(accountId, workspaceId)
  return cached ? configureAuthorizedConnectivityDiagnostics(cached) : false
}

export function suspendConnectivityDiagnostics(): void {
  const previous = runtime
  generation++
  runtime = null
  previous?.resolveReady(false)
  closeRuntimeResources()
  pumpStorage()
}

export function revokeConnectivityDiagnostics(
  config?: ConnectivityDiagnosticsConfig & { accountId?: string; decisionVersion?: string }
): void {
  const active = runtime
  const targetScope = config ? scopeOf(config) : active?.scope
  const accountId = config?.accountId ?? active?.config.accountId
  const workspaceId = config?.workspaceId ?? active?.config.workspaceId
  if (accountId && workspaceId && config?.decisionVersion) {
    const cached = readCachedConnectivityAuthorization(accountId, workspaceId)
    if (cached && cached.decisionVersion > config.decisionVersion) {
      configureAuthorizedConnectivityDiagnostics(cached)
      return
    }
  }
  const fallbackAuthorization =
    active && active.scope === targetScope
      ? { consentId: active.config.consentId, decisionVersion: active.config.decisionVersion }
      : undefined
  const consentId =
    accountId && workspaceId
      ? tombstoneConnectivityAuthorization(
          accountId,
          workspaceId,
          targetScope ?? "",
          fallbackAuthorization,
          config?.decisionVersion
        )
      : (fallbackAuthorization?.consentId ?? null)

  let sender: BroadcastChannel | null = null
  if (typeof BroadcastChannel !== "undefined") {
    try {
      sender = new BroadcastChannel("threa-connectivity-diagnostics")
    } catch {
      sender = null
    }
  }

  suspendConnectivityDiagnostics()
  if (!targetScope) {
    sender?.close()
    return
  }

  removePendingScope(targetScope)
  sender?.postMessage({ revokedScope: targetScope, consentId })
  if (!consentId) {
    sender?.close()
    return
  }

  queueRevocation({ scope: targetScope, consentId, failures: 0, nextAttemptAt: 0 })
  sender?.close()
  pumpStorage()
}

export function runConnectivityDiagnosticsMaintenance(): void {
  for (const request of readPendingConnectivityRevocations()) {
    if (!revocations.has(request.scope)) {
      queueRevocation({ ...request, failures: 0, nextAttemptAt: 0 })
    }
  }
  maintenanceRequested = true
  maintenanceNextAttemptAt = 0
  pumpStorage()
}

function onlineFlush(): void {
  void flushConnectivityDiagnostics()
}

function nextWakeAt(): number | null {
  const candidates: number[] = []
  for (const request of revocations.values()) candidates.push(request.nextAttemptAt)
  if (runtime?.initRequested && !revocations.has(runtime.scope)) candidates.push(runtime.nextInitAt)
  if (persistenceRequested) candidates.push(persistenceNextAttemptAt)
  if (maintenanceRequested) candidates.push(maintenanceNextAttemptAt)
  return candidates.length ? Math.min(...candidates) : null
}

function scheduleStorageWake(): void {
  if (storageTask || storageWakeTimer) return
  const wakeAt = nextWakeAt()
  if (wakeAt === null) return
  const delay = Math.max(0, wakeAt - Date.now())
  storageWakeTimer = setTimeout(() => {
    storageWakeTimer = null
    pumpStorage()
  }, delay)
}

function queueRevocation(request: RevocationRequest): void {
  if (!revocations.has(request.scope) && revocations.size >= MAX_CONSENT_ROWS) {
    const oldestScope = revocations.keys().next().value
    if (typeof oldestScope === "string") revocations.delete(oldestScope)
  }
  revocations.set(request.scope, request)
}

function takeEligibleRevocation(now: number): RevocationRequest | null {
  for (const [scope, request] of revocations) {
    if (request.nextAttemptAt > now) continue
    revocations.delete(scope)
    return request
  }
  return null
}

function pumpStorage(): void {
  if (storageTask) return
  if (storageWakeTimer) {
    clearTimeout(storageWakeTimer)
    storageWakeTimer = null
  }

  const now = Date.now()
  const revocation = takeEligibleRevocation(now)
  let work: Promise<void> | null = null

  if (revocation) {
    work = runRevocation(revocation)
  } else if (runtime?.initRequested && runtime.nextInitAt <= now && !revocations.has(runtime.scope)) {
    const target = runtime
    target.initRequested = false
    if (target.status === "retry_wait") {
      const ready = deferredReady()
      target.ready = ready.ready
      target.resolveReady = ready.resolveReady
      target.status = "initializing"
    }
    work = initializeRuntime(target)
  } else if (persistenceRequested && persistenceNextAttemptAt <= now) {
    persistenceRequested = false
    work = persistPending()
  } else if (maintenanceRequested && maintenanceNextAttemptAt <= now) {
    maintenanceRequested = false
    work = runMaintenance()
  }

  if (!work) {
    scheduleStorageWake()
    return
  }

  storageTask = work.finally(() => {
    storageTask = null
    pumpStorage()
  })
}

async function trimConsentRows(database: DiagnosticsDb, protectedScope?: string): Promise<Set<string>> {
  const rows = (await database.consent.toArray()).sort((left, right) => left.updatedAt - right.updatedAt)
  const excess = rows.length - MAX_CONSENT_ROWS
  if (excess <= 0) return new Set()
  const removed = rows.filter((row) => row.scope !== protectedScope).slice(0, excess)
  const scopes = new Set(removed.map((row) => row.scope))
  if (!scopes.size) return scopes
  await database.consent.bulkDelete([...scopes])
  for (const scope of scopes) await database.events.where("scope").equals(scope).delete()
  return scopes
}

async function initializeRuntime(target: Runtime): Promise<void> {
  try {
    const database = getDb()
    const result = await database.transaction("rw", database.events, database.consent, async () => {
      if (isConnectivityConsentTombstoned(target.config.consentId)) return null
      const prior = await database.consent.get(target.scope)
      if (isConnectivityConsentTombstoned(target.config.consentId)) return null
      const sameGrant = prior?.active === 1 && prior.consentId === target.config.consentId
      const epoch = sameGrant ? prior.epoch : (prior?.epoch ?? -1) + 1
      if (!sameGrant) await database.events.where("scope").equals(target.scope).delete()
      await database.consent.put({
        scope: target.scope,
        epoch,
        active: 1,
        consentId: target.config.consentId,
        updatedAt: Date.now(),
      })
      const removedScopes = await trimConsentRows(database, target.scope)
      return { epoch, removedScopes }
    })

    removePendingScopes(result?.removedScopes ?? new Set())
    if (
      !result ||
      runtime?.generation !== target.generation ||
      isConnectivityConsentTombstoned(target.config.consentId)
    ) {
      target.resolveReady(false)
      return
    }

    target.epoch = result.epoch
    target.status = "ready"
    target.initFailures = 0
    target.resolveReady(true)
    requestPersistence()
  } catch {
    target.resolveReady(false)
    if (runtime?.generation !== target.generation || isConnectivityConsentTombstoned(target.config.consentId)) return
    target.status = "retry_wait"
    target.initFailures++
    target.initRequested = true
    target.nextInitAt = Date.now() + retryDelay(target.initFailures)
  }
}

async function runRevocation(request: RevocationRequest): Promise<void> {
  try {
    const database = getDb()
    const removedScopes = await database.transaction("rw", database.events, database.consent, async () => {
      const prior = await database.consent.get(request.scope)
      if (prior?.active === 1 && prior.consentId !== request.consentId) return trimConsentRows(database)
      const epoch = (prior?.epoch ?? -1) + 1
      await database.consent.put({
        scope: request.scope,
        epoch,
        active: 0,
        consentId: request.consentId,
        updatedAt: Date.now(),
      })
      await database.events.where("scope").equals(request.scope).delete()
      return trimConsentRows(database)
    })
    removePendingScopes(removedScopes)
    clearConnectivityConsentTombstone(request.consentId)
  } catch {
    const newer = revocations.get(request.scope)
    if (!newer || newer.consentId === request.consentId) {
      request.failures++
      request.nextAttemptAt = Date.now() + retryDelay(request.failures)
      queueRevocation(request)
    }
  }
}

function requestPersistence(): void {
  if (!pending.length) return
  persistenceRequested = true
  pumpStorage()
}

async function persistPending(): Promise<void> {
  const ready = pending
  if (!ready.length) {
    persistenceFailures = 0
    return
  }
  pending = []
  pendingBytes = 0

  try {
    const database = getDb()
    const result = await database.transaction("rw", database.events, database.consent, async () => {
      const accepted: DiagnosticRow[] = []
      const deferred: PendingRow[] = []
      for (const item of ready) {
        if (isConnectivityConsentTombstoned(item.consentId)) continue
        const consent = await database.consent.get(item.row.scope)
        if (consent?.active === 1 && consent.consentId === item.consentId) {
          accepted.push({ ...item.row, consentEpoch: consent.epoch })
        } else if (
          runtime?.scope === item.row.scope &&
          runtime.config.consentId === item.consentId &&
          runtime.status !== "ready"
        ) {
          deferred.push(item)
        }
      }
      if (accepted.length) await database.events.bulkPut(accepted)
      await trimPersistedRows(database)
      const removedScopes = await trimConsentRows(database, runtime?.scope)
      return { deferred, removedScopes }
    })
    removePendingScopes(result.removedScopes)
    for (const item of result.deferred) enqueuePending(item)
    persistenceFailures = 0
    if (result.deferred.length) {
      persistenceRequested = true
      persistenceNextAttemptAt = Math.max(Date.now() + retryBaseMs, runtime?.nextInitAt ?? 0)
    } else {
      persistenceNextAttemptAt = 0
    }
  } catch {
    for (const item of ready) enqueuePending(item)
    persistenceFailures++
    persistenceRequested = true
    persistenceNextAttemptAt = Date.now() + retryDelay(persistenceFailures)
  }
}

async function runMaintenance(): Promise<void> {
  try {
    const database = getDb()
    const removedScopes = await database.transaction("rw", database.events, database.consent, async () => {
      await trimPersistedRows(database)
      return trimConsentRows(database, runtime?.scope)
    })
    removePendingScopes(removedScopes)
    maintenanceFailures = 0
    maintenanceNextAttemptAt = 0
  } catch {
    maintenanceFailures++
    maintenanceRequested = true
    maintenanceNextAttemptAt = Date.now() + retryDelay(maintenanceFailures)
  }
}

function projectFields(fields: DiagnosticFields): DiagnosticFields {
  const result: DiagnosticFields = {}
  const safeId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value)
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
    typeof value === "string" && allowed.includes(value as T)
  if (safeId(fields.operationId)) result.operationId = fields.operationId
  if (oneOf(fields.method, ["GET", "POST", "PUT", "PATCH", "DELETE"])) result.method = fields.method
  if (
    oneOf(fields.route, [
      "workspace_config",
      "messages",
      "streams",
      "sync",
      "attachments",
      "avatars",
      "agent_trace",
      "other",
    ])
  ) {
    result.route = fields.route
  }
  if (oneOf(fields.room, ["workspace", "stream", "agent_session", "other"])) result.room = fields.room
  if (oneOf(fields.transport, ["fetch", "xhr"])) result.transport = fields.transport
  if (Number.isInteger(fields.status) && fields.status! >= 0 && fields.status! <= 599) result.status = fields.status
  if (safeId(fields.correlationId)) result.correlationId = fields.correlationId
  if (safeId(fields.connectionId)) result.connectionId = fields.connectionId
  if (Number.isSafeInteger(fields.generation) && fields.generation! >= 0) result.generation = fields.generation
  if (Number.isSafeInteger(fields.attempt) && fields.attempt! >= 0 && fields.attempt! <= 1_000) {
    result.attempt = fields.attempt
  }
  if (oneOf(fields.reason, ["network", "timeout", "abort", "server", "transport", "unknown"])) {
    result.reason = fields.reason
  }
  if (oneOf(fields.blockedBy, ["socket", "in_flight", "lock"])) result.blockedBy = fields.blockedBy
  return result
}

export interface ConnectivityObservation {
  readonly id: string
  record(event: ConnectivityEvent, fields?: DiagnosticFields): void
  stall(event?: ConnectivityEvent, fields?: DiagnosticFields): () => void
}

const NOOP_OBSERVATION: ConnectivityObservation = { id: "", record: () => {}, stall: () => () => {} }

export function beginConnectivityObservation(fields: DiagnosticFields = {}): ConnectivityObservation {
  const captured = runtime
  if (!captured) return NOOP_OBSERVATION
  const id = createDiagnosticId()
  const base = projectFields({ ...fields, operationId: fields.operationId ?? id })
  const record = (event: ConnectivityEvent, extra: DiagnosticFields = {}) => {
    if (runtime?.generation !== captured.generation || runtime.scope !== captured.scope) return
    recordForRuntime(captured, event, { ...base, ...projectFields(extra) })
  }
  return {
    id,
    record,
    stall(event = "http_stalled", extra = {}) {
      if (runtime?.generation !== captured.generation || stallTimers.size >= MAX_STALL_TIMERS) return () => {}
      const timer = setTimeout(() => {
        stallTimers.delete(timer)
        record(event, extra)
        triggerFlush()
      }, STALL_MS)
      stallTimers.add(timer)
      return () => {
        clearTimeout(timer)
        stallTimers.delete(timer)
      }
    },
  }
}

function enqueuePending(item: PendingRow): void {
  if (item.row.byteSize > MAX_MEMORY_BYTES) return
  while (pending.length && (pending.length >= MAX_MEMORY_ROWS || pendingBytes + item.row.byteSize > MAX_MEMORY_BYTES)) {
    pendingBytes -= pending.shift()!.row.byteSize
  }
  pending.push(item)
  pendingBytes += item.row.byteSize
}

function recordForRuntime(captured: Runtime, event: ConnectivityEvent, fields: DiagnosticFields): void {
  try {
    const base = {
      ...projectFields(fields),
      id: createDiagnosticId(),
      scope: captured.scope,
      event,
      bootId,
      browserSessionId,
      appVersion: currentAppVersion() ?? "unknown",
      wallTime: new Date().toISOString(),
      monotonicMs: performance.now(),
      createdAt: Date.now(),
      consentEpoch: captured.epoch ?? -1,
    }
    const row: DiagnosticRow = { ...base, byteSize: byteLength(base) }
    enqueuePending({ row, consentId: captured.config.consentId })
    requestPersistence()
  } catch {
    // Observation cannot affect product work.
  }
}

export function recordConnectivityEvent(event: ConnectivityEvent, fields: DiagnosticFields = {}): void {
  const current = runtime
  if (current) recordForRuntime(current, event, fields)
}

async function trimPersistedRows(database: DiagnosticsDb): Promise<void> {
  await deleteExpiredRows(database)
  const rows = await database.events.orderBy("createdAt").toArray()
  let bytes = rows.reduce((sum, row) => sum + row.byteSize, 0)
  let removeCount = Math.max(0, rows.length - MAX_ROWS)
  for (let index = 0; index < removeCount; index++) bytes -= rows[index]!.byteSize
  while (removeCount < rows.length && bytes > MAX_BYTES) bytes -= rows[removeCount++]!.byteSize
  if (removeCount) await database.events.bulkDelete(rows.slice(0, removeCount).map((row) => row.id))
}

function triggerFlush(): void {
  const now = Date.now()
  if (now - lastTriggeredFlush < MIN_TRIGGER_FLUSH_MS) return
  lastTriggeredFlush = now
  void flushConnectivityDiagnostics()
}

function boundedResult(work: Promise<boolean>): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), networkTimeoutMs)
    void work.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      () => {
        clearTimeout(timer)
        resolve(false)
      }
    )
  })
}

export function flushConnectivityDiagnostics(): Promise<boolean> {
  const currentGeneration = runtime?.generation ?? generation
  if (!flushState || flushState.generation !== currentGeneration) {
    const state = { generation: currentGeneration, promise: Promise.resolve(false) }
    state.promise = runFlush().finally(() => {
      if (flushState === state) flushState = null
    })
    flushState = state
  }
  return boundedResult(flushState.promise)
}

async function persistCurrentScope(captured: Runtime): Promise<boolean> {
  while (pending.some((item) => item.row.scope === captured.scope && item.consentId === captured.config.consentId)) {
    if (runtime?.generation !== captured.generation) return false
    requestPersistence()
    const active = storageTask
    if (!active || persistenceNextAttemptAt > Date.now()) return false
    await active
  }
  return true
}

async function runFlush(): Promise<boolean> {
  const captured = runtime
  if (!captured) return true
  if (!(await captured.ready)) return false
  if (runtime?.generation !== captured.generation || !(await persistCurrentScope(captured))) return false

  try {
    const database = getDb()
    await database.transaction("rw", database.events, () => trimPersistedRows(database))
    if (runtime?.generation !== captured.generation) return false
    const snapshot = (await database.events.where("scope").equals(captured.scope).sortBy("createdAt")).slice(
      0,
      MAX_ROWS
    )

    for (let offset = 0; offset < snapshot.length; offset += DELIVERY_BATCH_SIZE) {
      if (runtime?.generation !== captured.generation) return false
      const batch = snapshot.slice(offset, offset + DELIVERY_BATCH_SIZE)
      const consent = await database.consent.get(captured.scope)
      if (
        runtime?.generation !== captured.generation ||
        isConnectivityConsentTombstoned(captured.config.consentId) ||
        consent?.active !== 1 ||
        consent.epoch !== captured.epoch ||
        consent.consentId !== captured.config.consentId
      ) {
        return false
      }

      const controller = new AbortController()
      uploadController = controller
      const timer = setTimeout(() => controller.abort(), networkTimeoutMs)
      let response: Response
      try {
        response = await fetch(`${captured.config.host.replace(/\/$/, "")}/batch/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          signal: controller.signal,
          body: JSON.stringify({
            api_key: captured.config.token,
            batch: batch.map((row) => ({
              event: `connectivity_${row.event}`,
              uuid: row.id,
              timestamp: row.wallTime,
              properties: toPostHogProperties(row, captured.config),
            })),
          }),
        })
      } finally {
        clearTimeout(timer)
        if (uploadController === controller) uploadController = null
      }

      if (runtime?.generation !== captured.generation || response.status !== 200) return false
      const acknowledged = await database.transaction("rw", database.events, database.consent, async () => {
        const currentConsent = await database.consent.get(captured.scope)
        if (
          runtime?.generation !== captured.generation ||
          isConnectivityConsentTombstoned(captured.config.consentId) ||
          currentConsent?.active !== 1 ||
          currentConsent.epoch !== captured.epoch ||
          currentConsent.consentId !== captured.config.consentId
        ) {
          return false
        }
        await database.events.bulkDelete(batch.map((row) => row.id))
        return true
      })
      if (!acknowledged || runtime?.generation !== captured.generation) return false
    }

    return !pending.some(({ row }) => row.scope === captured.scope)
  } catch {
    return false
  }
}

function toPostHogProperties(
  row: DiagnosticRow,
  current: AuthorizedConnectivityDiagnosticsConfig
): Record<string, unknown> {
  const {
    id,
    event: _event,
    scope: _scope,
    createdAt: _createdAt,
    byteSize: _byteSize,
    consentEpoch: _epoch,
    ...safe
  } = row
  return { ...safe, $insert_id: id, distinct_id: current.userId, workspace_id: current.workspaceId }
}

registerConnectivityDiagnosticsRuntime({
  begin: beginConnectivityObservation,
  flush: flushConnectivityDiagnostics,
  record: recordConnectivityEvent,
})

export const connectivityDiagnosticsTestApi = {
  get db() {
    return getDb()
  },
  scopeOf,
  MAX_ROWS,
  MAX_BYTES,
  MAX_AGE_MS,
  MAX_MEMORY_ROWS,
  MAX_STALL_TIMERS,
  MAX_CONSENT_ROWS,
  STALL_MS,
  NETWORK_TIMEOUT_MS,
  stallTimerCount: () => stallTimers.size,
  pendingCount: () => pending.length,
  revocationCount: () => revocations.size,
  clearRevocationsInMemory: () => revocations.clear(),
  runtimeState: () => runtime && { status: runtime.status, epoch: runtime.epoch, initRequested: runtime.initRequested },
  setNetworkTimeoutMs: (value: number) => {
    networkTimeoutMs = value
  },
  setRetryBaseMs: (value: number) => {
    retryBaseMs = value
  },
  readCachedAuthorization: readCachedConnectivityAuthorization,
  isTombstoned: isConnectivityConsentTombstoned,
}
