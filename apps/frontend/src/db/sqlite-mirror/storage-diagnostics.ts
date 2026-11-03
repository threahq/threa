import { recordConnectivityEvent, type DiagnosticFields } from "@/lib/connectivity-diagnostics/facade"
import { isStorageRestartPending, type SqliteStorageMode } from "./storage-mode"

export type StorageFailureKind = NonNullable<DiagnosticFields["kind"]>

const SUMMARY_INTERVAL_MS = 5 * 60_000
const MAX_SAMPLES = 10_000

interface StorageContext {
  storageMode: SqliteStorageMode
  requestedMode: SqliteStorageMode
  role?: "owner" | "follower"
}

let context: StorageContext = { storageMode: "off", requestedMode: "off" }
let sqliteReadMs: number[] = []
let rangeReadMs: number[] = []
let fallbacks = 0
let summarizedAt = Date.now()

function common(): DiagnosticFields {
  return { ...context, restartPending: isStorageRestartPending() }
}

/** The mode this boot runs and the one the flag asks for; every later storage event carries both. */
export function setStorageContext(storageMode: SqliteStorageMode, requestedMode: SqliteStorageMode): void {
  context = { storageMode, requestedMode }
}

export function reportStorageBoot(role: "owner" | "follower", fields: DiagnosticFields = {}): void {
  context = { ...context, role }
  recordConnectivityEvent("storage_boot", { ...common(), ...fields })
}

export function reportStorageFailure(kind: StorageFailureKind, fields: DiagnosticFields = {}): void {
  recordConnectivityEvent("storage_failure", { ...common(), kind, ...fields })
}

export function reportStorageRecovered(fields: DiagnosticFields = {}): void {
  recordConnectivityEvent("storage_recovered", { ...common(), ...fields })
}

export function observeSqliteRead(ms: number): void {
  if (sqliteReadMs.length < MAX_SAMPLES) sqliteReadMs.push(ms)
  summarizeWhenDue()
}

export function observeReadFallback(): void {
  fallbacks++
  summarizeWhenDue()
}

/** A timeline range read, whichever engine answered: the latency the user waits on at a stream switch. */
export function observeRangeRead(ms: number): void {
  if (rangeReadMs.length < MAX_SAMPLES) rangeReadMs.push(ms)
  summarizeWhenDue()
}

/** Summaries ride on observations rather than a timer: an idle session has nothing to summarize, and no timer outlives its page or test. */
function summarizeWhenDue(): void {
  if (Date.now() - summarizedAt >= SUMMARY_INTERVAL_MS) flushStorageSummary()
}

function percentiles(samples: number[]): { p50?: number; p95?: number } {
  if (samples.length === 0) return {}
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => Math.round(sorted[Math.ceil(q * sorted.length) - 1]!)
  return { p50: at(0.5), p95: at(0.95) }
}

export function flushStorageSummary(): void {
  summarizedAt = Date.now()
  if (sqliteReadMs.length === 0 && rangeReadMs.length === 0 && fallbacks === 0) return
  const sqlite = percentiles(sqliteReadMs)
  const range = percentiles(rangeReadMs)
  recordConnectivityEvent("storage_summary", {
    ...common(),
    count: sqliteReadMs.length,
    p50Ms: sqlite.p50,
    p95Ms: sqlite.p95,
    rangeP50Ms: range.p50,
    rangeP95Ms: range.p95,
    fallbacks,
  })
  sqliteReadMs = []
  rangeReadMs = []
  fallbacks = 0
}

export function resetStorageDiagnosticsForTests(): void {
  context = { storageMode: "off", requestedMode: "off" }
  sqliteReadMs = []
  rangeReadMs = []
  fallbacks = 0
  summarizedAt = Date.now()
}
