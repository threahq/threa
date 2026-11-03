import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  authorizeConnectivityDiagnostics,
  connectivityDiagnosticsTestApi,
  suspendConnectivityDiagnostics,
} from "@/lib/connectivity-diagnostics/index"
import { requestStorageRestart, resetStorageRestartForTests } from "./storage-mode"
import {
  flushStorageSummary,
  observeRangeRead,
  observeReadFallback,
  observeSqliteRead,
  reportStorageBoot,
  reportStorageFailure,
  resetStorageDiagnosticsForTests,
  setStorageContext,
} from "./storage-diagnostics"

const scope = {
  token: "phc_test",
  host: "https://eu.posthog.test",
  userId: "usr_1",
  workspaceId: "ws_1",
  region: "eu",
}

async function storedEvents() {
  const rows = await connectivityDiagnosticsTestApi.db.events.toArray()
  return rows
    .sort((a, b) => a.monotonicMs - b.monotonicMs)
    .map(
      ({
        id,
        scope,
        bootId,
        browserSessionId,
        appVersion,
        wallTime,
        monotonicMs,
        createdAt,
        byteSize,
        consentEpoch,
        ...fields
      }) => fields
    )
}

describe("storage diagnostics", () => {
  beforeEach(async () => {
    suspendConnectivityDiagnostics()
    localStorage.clear()
    await connectivityDiagnosticsTestApi.db.events.clear()
    await connectivityDiagnosticsTestApi.db.consent.clear()
    resetStorageDiagnosticsForTests()
    resetStorageRestartForTests()
    authorizeConnectivityDiagnostics("workos_1", scope, "preferences_v1")
  })

  afterEach(() => {
    suspendConnectivityDiagnostics()
    resetStorageDiagnosticsForTests()
    resetStorageRestartForTests()
  })

  it("records boots, failures and a read summary under the running and requested modes", async () => {
    setStorageContext("read-write", "read-write")
    reportStorageBoot("owner", { openMs: 42 })
    reportStorageFailure("worker_failed", { attempt: 2 })
    requestStorageRestart("threa-account-a")
    for (const ms of [5, 10, 20, 400]) observeSqliteRead(ms)
    for (const ms of [8, 30]) observeRangeRead(ms)
    observeReadFallback()
    flushStorageSummary()
    flushStorageSummary()

    await vi.waitFor(async () => expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(3))
    expect(await storedEvents()).toEqual([
      {
        event: "storage_boot",
        storageMode: "read-write",
        requestedMode: "read-write",
        role: "owner",
        restartPending: false,
        openMs: 42,
      },
      {
        event: "storage_failure",
        storageMode: "read-write",
        requestedMode: "read-write",
        role: "owner",
        restartPending: false,
        kind: "worker_failed",
        attempt: 2,
      },
      {
        event: "storage_summary",
        storageMode: "read-write",
        requestedMode: "read-write",
        role: "owner",
        restartPending: true,
        count: 4,
        p50Ms: 10,
        p95Ms: 400,
        rangeP50Ms: 8,
        rangeP95Ms: 30,
        fallbacks: 1,
      },
    ])
  })
})
