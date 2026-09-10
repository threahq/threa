import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  authorizeConnectivityDiagnostics,
  beginConnectivityObservation,
  connectivityDiagnosticsTestApi,
  flushConnectivityDiagnostics,
  recordConnectivityEvent,
  restoreConnectivityDiagnostics,
  revokeConnectivityDiagnostics,
  runConnectivityDiagnosticsMaintenance,
  suspendConnectivityDiagnostics,
} from "./index"

const scope = {
  token: "phc_test",
  host: "https://eu.posthog.test",
  userId: "usr_1",
  workspaceId: "ws_1",
  region: "eu",
}
const otherScope = { ...scope, userId: "usr_2", workspaceId: "ws_2" }
const accountId = "workos_1"

function configureConnectivityDiagnostics(
  config = scope,
  account = accountId,
  decisionVersion = "preferences_v1"
): void {
  authorizeConnectivityDiagnostics(account, config, decisionVersion)
}

async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await vi.waitFor(async () => expect(await connectivityDiagnosticsTestApi.db.events.count()).toBeGreaterThan(0))
}

describe("connectivity diagnostics persistence", () => {
  beforeEach(async () => {
    suspendConnectivityDiagnostics()
    localStorage.clear()
    await connectivityDiagnosticsTestApi.db.events.clear()
    await connectivityDiagnosticsTestApi.db.consent.clear()
    vi.restoreAllMocks()
    connectivityDiagnosticsTestApi.setNetworkTimeoutMs(connectivityDiagnosticsTestApi.NETWORK_TIMEOUT_MS)
    connectivityDiagnosticsTestApi.setRetryBaseMs(20)
  })

  afterEach(() => suspendConnectivityDiagnostics())

  it("should retain a newer grant when an older denial arrives after effect cleanup", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }))
    configureConnectivityDiagnostics(scope, accountId, "2026-09-09T20:02:00.000Z")
    recordConnectivityEvent("socket_connect")
    await settleWrites()
    const original = connectivityDiagnosticsTestApi.readCachedAuthorization(accountId, scope.workspaceId)
    suspendConnectivityDiagnostics()
    revokeConnectivityDiagnostics({ ...scope, accountId, decisionVersion: "2026-09-09T20:01:00.000Z" })
    expect(await flushConnectivityDiagnostics()).toBe(true)
    expect(connectivityDiagnosticsTestApi.readCachedAuthorization(accountId, scope.workspaceId)).toEqual(original)
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(0)
  })

  it("should retain one UUID through failure, restart, replay, and endpoint acknowledgement", async () => {
    const payloads: Array<{ uuid: string; insertId: string }> = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const event = JSON.parse(String(init?.body)).batch[0]
      payloads.push({ uuid: event.uuid, insertId: event.properties.$insert_id })
      return new Response(null, { status: payloads.length === 1 ? 503 : 200 })
    })

    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("http_start", { operationId: "op_1", method: "GET", route: "streams" })
    await settleWrites()

    expect(await flushConnectivityDiagnostics()).toBe(false)
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(1)
    suspendConnectivityDiagnostics()
    configureConnectivityDiagnostics(scope)
    expect(await flushConnectivityDiagnostics()).toBe(true)

    expect(payloads).toEqual([
      { uuid: payloads[0]!.uuid, insertId: payloads[0]!.uuid },
      { uuid: payloads[0]!.uuid, insertId: payloads[0]!.uuid },
    ])
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(0)
  })

  it("should recover from an initialization failure and deliver the buffered event", async () => {
    const database = connectivityDiagnosticsTestApi.db
    const transaction = vi.spyOn(database, "transaction")
    transaction.mockRejectedValueOnce(new Error("IndexedDB unavailable"))
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }))

    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("http_start", { method: "GET", route: "workspace_config" })

    expect(await flushConnectivityDiagnostics()).toBe(false)
    await vi.waitFor(async () => {
      expect((await database.consent.toCollection().first())?.active).toBe(1)
      expect(await database.events.count()).toBe(1)
    })
    expect(await flushConnectivityDiagnostics()).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("should load consent once per scope for a pending persistence cycle", async () => {
    const database = connectivityDiagnosticsTestApi.db
    const bulkGet = vi.spyOn(database.consent, "bulkGet")

    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_connect", { operationId: "op_1" })
    recordConnectivityEvent("socket_disconnect", { operationId: "op_2" })

    await vi.waitFor(async () => expect(await database.events.count()).toBe(2))
    expect(bulkGet.mock.calls).toEqual([[[connectivityDiagnosticsTestApi.scopeOf(scope)]]])
  })

  it("should keep one initialization operation while storage hangs and recover after it settles", async () => {
    connectivityDiagnosticsTestApi.setNetworkTimeoutMs(20)
    const database = connectivityDiagnosticsTestApi.db
    const originalTransaction = database.transaction.bind(database)
    let releaseStorage!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseStorage = resolve
    })
    const transaction = vi.spyOn(database, "transaction")
    transaction.mockImplementationOnce((async (...args: Parameters<typeof database.transaction>) => {
      await blocked
      return originalTransaction(...args)
    }) as unknown as typeof database.transaction)
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }))

    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_connect")
    expect(await flushConnectivityDiagnostics()).toBe(false)
    expect(transaction).toHaveBeenCalledTimes(1)

    releaseStorage()
    await vi.waitFor(async () => {
      expect({
        consent: (await database.consent.toCollection().first())?.active,
        events: await database.events.count(),
        pending: connectivityDiagnosticsTestApi.pendingCount(),
        runtime: connectivityDiagnosticsTestApi.runtimeState(),
        sends: fetch.mock.calls.length,
      }).toEqual({
        consent: 1,
        events: 0,
        pending: 0,
        runtime: { status: "ready", epoch: 0, initRequested: false },
        sends: 1,
      })
    })
    expect(await flushConnectivityDiagnostics()).toBe(true)
    expect(transaction.mock.calls.length).toBeGreaterThan(1)
  })

  it("should retain failed and offline delivery without treating SDK enqueue as acknowledgement", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_disconnect", { reason: "transport" })
    await settleWrites()

    expect(await flushConnectivityDiagnostics()).toBe(false)
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(1)
    expect(await flushConnectivityDiagnostics()).toBe(false)
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(1)
    expect(await flushConnectivityDiagnostics()).toBe(true)
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(0)
  })

  it("should bound persisted rows, encoded bytes, and age", async () => {
    configureConnectivityDiagnostics(scope)
    for (let index = 0; index < connectivityDiagnosticsTestApi.MAX_ROWS + 80; index++) {
      recordConnectivityEvent("http_start", { operationId: crypto.randomUUID(), method: "GET", route: "messages" })
      if (index % 50 === 49) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await settleWrites()
    const existing = await connectivityDiagnosticsTestApi.db.events.orderBy("createdAt").first()
    expect(existing).toBeDefined()
    await connectivityDiagnosticsTestApi.db.events.update(existing!.id, {
      createdAt: Date.now() - connectivityDiagnosticsTestApi.MAX_AGE_MS - 1,
    })
    recordConnectivityEvent("http_start", { method: "GET", route: "sync" })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const rows = await connectivityDiagnosticsTestApi.db.events.toArray()
    expect({
      withinCount: rows.length <= connectivityDiagnosticsTestApi.MAX_ROWS,
      withinBytes: rows.reduce((sum, row) => sum + row.byteSize, 0) <= connectivityDiagnosticsTestApi.MAX_BYTES,
      oldRowPresent: rows.some((row) => row.id === existing!.id),
    }).toEqual({ withinCount: true, withinBytes: true, oldRowPresent: false })
  })

  it("should isolate account switches and preserve the inactive scope for a later restart", async () => {
    const sentUsers: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sentUsers.push(JSON.parse(String(init?.body)).batch[0].properties.distinct_id)
      return new Response(null, { status: 200 })
    })
    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_disconnect")
    configureConnectivityDiagnostics(otherScope)
    recordConnectivityEvent("socket_connect")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(await flushConnectivityDiagnostics()).toBe(true)
    expect(sentUsers).toEqual(["usr_2"])
    expect((await connectivityDiagnosticsTestApi.db.events.toArray()).map((row) => row.scope)).toEqual([
      connectivityDiagnosticsTestApi.scopeOf(scope),
    ])

    configureConnectivityDiagnostics(scope)
    expect(await flushConnectivityDiagnostics()).toBe(true)
    expect(sentUsers).toEqual(["usr_2", "usr_1"])
  })

  it("should restore cached consent only for the authenticated account and workspace", async () => {
    configureConnectivityDiagnostics(scope)
    const cached = connectivityDiagnosticsTestApi.readCachedAuthorization(accountId, scope.workspaceId)
    expect(cached).toEqual(expect.objectContaining({ accountId, userId: scope.userId, workspaceId: scope.workspaceId }))
    suspendConnectivityDiagnostics()

    expect(restoreConnectivityDiagnostics("workos_2", scope.workspaceId)).toBe(false)
    expect(beginConnectivityObservation().id).toBe("")
    expect(restoreConnectivityDiagnostics(accountId, scope.workspaceId)).toBe(true)
    expect(beginConnectivityObservation().id).not.toBe("")
  })

  it("should keep the app running when authorization storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })

    expect(() => configureConnectivityDiagnostics(scope)).not.toThrow()
    expect(beginConnectivityObservation().id).not.toBe("")
    expect(() => revokeConnectivityDiagnostics()).not.toThrow()
  })

  it("should restore revoked-scope cleanup after reload without restoring cached consent", async () => {
    connectivityDiagnosticsTestApi.setRetryBaseMs(1_000)
    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_disconnect")
    await settleWrites()
    const cached = connectivityDiagnosticsTestApi.readCachedAuthorization(accountId, scope.workspaceId)
    const database = connectivityDiagnosticsTestApi.db
    vi.spyOn(database, "transaction").mockRejectedValueOnce(new Error("cleanup failed"))

    revokeConnectivityDiagnostics()

    expect(connectivityDiagnosticsTestApi.isTombstoned(cached!.consentId)).toBe(true)
    expect(restoreConnectivityDiagnostics(accountId, scope.workspaceId)).toBe(false)
    await vi.waitFor(() => expect(connectivityDiagnosticsTestApi.revocationCount()).toBe(1))
    connectivityDiagnosticsTestApi.clearRevocationsInMemory()
    runConnectivityDiagnosticsMaintenance()
    await vi.waitFor(async () => {
      expect(await database.events.count()).toBe(0)
      expect((await database.consent.get(connectivityDiagnosticsTestApi.scopeOf(scope)))?.active).toBe(0)
    })
    expect(connectivityDiagnosticsTestApi.isTombstoned(cached!.consentId)).toBe(true)
    configureConnectivityDiagnostics(scope)
    expect(connectivityDiagnosticsTestApi.readCachedAuthorization(accountId, scope.workspaceId)).toBeNull()
    expect(beginConnectivityObservation().id).toBe("")
  })

  it("should distinguish a later explicit opt-in from a stale revoked grant", async () => {
    configureConnectivityDiagnostics(scope)
    await vi.waitFor(async () => {
      expect((await connectivityDiagnosticsTestApi.db.consent.toCollection().first())?.active).toBe(1)
    })
    const oldGrant = connectivityDiagnosticsTestApi.readCachedAuthorization(accountId, scope.workspaceId)!
    vi.spyOn(connectivityDiagnosticsTestApi.db, "transaction").mockRejectedValueOnce(new Error("cleanup failed"))

    revokeConnectivityDiagnostics()
    configureConnectivityDiagnostics(scope, accountId, "preferences_v2")
    const newGrant = connectivityDiagnosticsTestApi.readCachedAuthorization(accountId, scope.workspaceId)!

    expect(newGrant.consentId).not.toBe(oldGrant.consentId)
    await vi.waitFor(async () => {
      const consent = await connectivityDiagnosticsTestApi.db.consent.get(connectivityDiagnosticsTestApi.scopeOf(scope))
      expect(consent).toEqual(expect.objectContaining({ active: 1, consentId: newGrant.consentId }))
    })
    recordConnectivityEvent("socket_connect")
    await settleWrites()
  })

  it("should clear only the revoked scope and reject its stale callback", async () => {
    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_disconnect")
    revokeConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_connect")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(0)
  })

  it("should apply a revocation broadcast from another tab", async () => {
    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_disconnect")
    await settleWrites()
    const revokedScope = connectivityDiagnosticsTestApi.scopeOf(scope)
    const prior = await connectivityDiagnosticsTestApi.db.consent.get(revokedScope)
    await connectivityDiagnosticsTestApi.db.transaction(
      "rw",
      connectivityDiagnosticsTestApi.db.events,
      connectivityDiagnosticsTestApi.db.consent,
      async () => {
        await connectivityDiagnosticsTestApi.db.consent.put({
          scope: revokedScope,
          epoch: prior!.epoch + 1,
          active: 0,
          consentId: prior!.consentId,
          updatedAt: Date.now(),
        })
        await connectivityDiagnosticsTestApi.db.events.where("scope").equals(revokedScope).delete()
      }
    )
    const otherTab = new BroadcastChannel("threa-connectivity-diagnostics")
    otherTab.postMessage({ revokedScope, consentId: prior!.consentId })
    await vi.waitFor(() => expect(beginConnectivityObservation().id).toBe(""))
    recordConnectivityEvent("socket_connect")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(0)
    otherTab.close()
  })

  it("should retain events from a new consent epoch across a restart", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }))
    configureConnectivityDiagnostics(scope)
    revokeConnectivityDiagnostics(scope)
    await vi.waitFor(async () => {
      expect((await connectivityDiagnosticsTestApi.db.consent.toCollection().first())?.active).toBe(0)
    })

    configureConnectivityDiagnostics(scope, accountId, "preferences_v2")
    await new Promise((resolve) => setTimeout(resolve, 0))
    recordConnectivityEvent("socket_connect")
    await settleWrites()
    suspendConnectivityDiagnostics()
    configureConnectivityDiagnostics(scope, accountId, "preferences_v2")

    expect(await flushConnectivityDiagnostics()).toBe(true)
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(0)
  })

  it("should drain more than one batch and retain every bounded event identity", async () => {
    const batches: Array<Array<{ properties: { operationId: string } }>> = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      batches.push(JSON.parse(String(init?.body)).batch)
      return new Response(null, { status: 200 })
    })
    configureConnectivityDiagnostics(scope)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const operationIds = Array.from(
      { length: connectivityDiagnosticsTestApi.MAX_MEMORY_ROWS },
      (_, index) => `op_${index}`
    )
    for (const operationId of operationIds)
      recordConnectivityEvent("http_start", { operationId, method: "GET", route: "messages" })
    await settleWrites()

    expect(await flushConnectivityDiagnostics()).toBe(true)
    expect(batches.map((batch) => batch.length)).toEqual([50, 50])
    expect(
      batches
        .flat()
        .map((event) => event.properties.operationId)
        .sort()
    ).toEqual(operationIds.sort())
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(0)
  })

  it("should bound active consent metadata during maintenance", async () => {
    const database = connectivityDiagnosticsTestApi.db
    await database.consent.bulkPut(
      Array.from({ length: connectivityDiagnosticsTestApi.MAX_CONSENT_ROWS + 10 }, (_, index) => ({
        scope: `scope_${index}`,
        epoch: 0,
        active: 1 as const,
        consentId: `consent_${index}`,
        updatedAt: index,
      }))
    )

    runConnectivityDiagnosticsMaintenance()

    await vi.waitFor(async () => {
      expect(await database.consent.count()).toBe(connectivityDiagnosticsTestApi.MAX_CONSENT_ROWS)
    })
  })

  it("should physically delete expired rows when the database opens without active diagnostics", async () => {
    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_disconnect")
    await settleWrites()
    const database = connectivityDiagnosticsTestApi.db
    const row = await database.events.toCollection().first()
    await database.events.update(row!.id, {
      createdAt: Date.now() - connectivityDiagnosticsTestApi.MAX_AGE_MS - 1,
    })
    suspendConnectivityDiagnostics()

    database.close()
    await database.open()

    expect(await database.events.count()).toBe(0)
  })

  it("should trim expired rows before upload after a restart", async () => {
    const sent: unknown[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(...JSON.parse(String(init?.body)).batch)
      return new Response(null, { status: 200 })
    })
    configureConnectivityDiagnostics(scope)
    await new Promise((resolve) => setTimeout(resolve, 0))
    recordConnectivityEvent("socket_disconnect")
    await settleWrites()
    const row = await connectivityDiagnosticsTestApi.db.events.toCollection().first()
    await connectivityDiagnosticsTestApi.db.events.update(row!.id, {
      createdAt: Date.now() - connectivityDiagnosticsTestApi.MAX_AGE_MS - 1,
    })
    suspendConnectivityDiagnostics()
    configureConnectivityDiagnostics(scope)

    expect(await flushConnectivityDiagnostics()).toBe(true)
    expect(sent).toEqual([])
  })

  it("should retain an acknowledged batch when durable consent changes during its upload", async () => {
    let releaseFetch!: () => void
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseFetch = resolve
      })
      return new Response(null, { status: 200 })
    })
    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_disconnect")
    await settleWrites()
    const delivery = flushConnectivityDiagnostics()
    await vi.waitFor(() => expect(releaseFetch).toBeTypeOf("function"))
    const durableScope = connectivityDiagnosticsTestApi.scopeOf(scope)
    const consent = await connectivityDiagnosticsTestApi.db.consent.get(durableScope)
    await connectivityDiagnosticsTestApi.db.consent.put({
      ...consent!,
      epoch: consent!.epoch + 1,
      active: 0,
      updatedAt: Date.now(),
    })
    releaseFetch()

    expect(await delivery).toBe(false)
    expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(1)
  })

  it("should cancel delivery when another tab withdraws consent during the consent read", async () => {
    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_disconnect")
    await settleWrites()
    const database = connectivityDiagnosticsTestApi.db
    const originalGet = database.consent.get.bind(database.consent)
    let releaseConsent!: () => void
    let markConsentRead!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseConsent = resolve
    })
    const consentRead = new Promise<void>((resolve) => {
      markConsentRead = resolve
    })
    vi.spyOn(database.consent, "get").mockImplementationOnce((async (
      key: Parameters<typeof database.consent.get>[0]
    ) => {
      const value = await originalGet(key)
      markConsentRead()
      await blocked
      return value
    }) as unknown as typeof database.consent.get)
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }))

    const delivery = flushConnectivityDiagnostics()
    await consentRead
    const otherTab = new BroadcastChannel("threa-connectivity-diagnostics")
    otherTab.postMessage({ revokedScope: connectivityDiagnosticsTestApi.scopeOf(scope) })
    await vi.waitFor(() => expect(beginConnectivityObservation().id).toBe(""))
    releaseConsent()

    expect(await delivery).toBe(false)
    expect(send).not.toHaveBeenCalled()
    otherTab.close()
  })

  it("should cap and cancel stall timers", () => {
    configureConnectivityDiagnostics(scope)
    const cancel = Array.from({ length: connectivityDiagnosticsTestApi.MAX_STALL_TIMERS + 20 }, () =>
      beginConnectivityObservation().stall()
    )
    expect(connectivityDiagnosticsTestApi.stallTimerCount()).toBe(connectivityDiagnosticsTestApi.MAX_STALL_TIMERS)
    cancel.forEach((stop) => stop())
    expect(connectivityDiagnosticsTestApi.stallTimerCount()).toBe(0)
  })

  it("should back off after a persistence error instead of spinning", async () => {
    connectivityDiagnosticsTestApi.setRetryBaseMs(1_000)
    configureConnectivityDiagnostics(scope)
    await vi.waitFor(async () =>
      expect((await connectivityDiagnosticsTestApi.db.consent.toCollection().first())?.active).toBe(1)
    )
    const transaction = vi.spyOn(connectivityDiagnosticsTestApi.db, "transaction")
    transaction.mockRejectedValueOnce(new Error("IndexedDB unavailable"))
    recordConnectivityEvent("socket_disconnect")

    await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(transaction).toHaveBeenCalledTimes(1)
    await vi.waitFor(async () => expect(await connectivityDiagnosticsTestApi.db.events.count()).toBe(1), {
      timeout: 1_500,
    })
  })

  it("should bound a hung upload and reuse its single underlying request", async () => {
    connectivityDiagnosticsTestApi.setNetworkTimeoutMs(20)
    let signal: AbortSignal | undefined
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    configureConnectivityDiagnostics(scope)
    recordConnectivityEvent("socket_disconnect")
    await settleWrites()

    const first = flushConnectivityDiagnostics()
    const second = flushConnectivityDiagnostics()
    expect(await Promise.all([first, second])).toEqual([false, false])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    revokeConnectivityDiagnostics(scope)
    expect(signal?.aborted).toBe(true)
  })

  it("should expose only allowlisted route and room categories", async () => {
    const { categorizeRoom, categorizeRoute } = await import("./index")
    expect([
      categorizeRoute("/api/workspaces/ws_secret/config?token=secret"),
      categorizeRoute("/api/workspaces/ws_secret/streams/stream_secret/messages"),
      categorizeRoute("https://region.test/api/workspaces/ws_secret/attachments/attach_secret/content"),
      categorizeRoute("/api/workspaces/ws_secret/profile/avatar"),
      categorizeRoute("/api/workspaces/ws_secret/streams"),
      categorizeRoute("/api/workspaces/ws_secret/sync?after=secret"),
      categorizeRoute("/api/workspaces/ws_secret/agent-sessions/session_secret/events"),
      categorizeRoute("/api/workspaces/ws_secret/agent/trace"),
      categorizeRoute("/private/raw/path"),
    ]).toEqual([
      "workspace_config",
      "messages",
      "attachments",
      "avatars",
      "streams",
      "sync",
      "agent_trace",
      "other",
      "other",
    ])
    expect([
      categorizeRoom("ws:ws_1"),
      categorizeRoom("ws:ws_1:stream:stream_1"),
      categorizeRoom("ws:ws_1:agent_session:session_1"),
      categorizeRoom("stream:secret"),
    ]).toEqual(["workspace", "stream", "agent_session", "other"])
  })
})
