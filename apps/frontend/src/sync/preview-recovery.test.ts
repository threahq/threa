import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import Dexie from "dexie"
import { render, cleanup } from "@testing-library/react"
import { db, getActiveDb } from "@/db/database"
import * as eventWrites from "@/db/event-writes"
import { ApiError } from "@/api/client"
import { streamKeys } from "@/hooks/use-streams"
import { useStreamWarmup } from "@/hooks/use-stream-warmup"
import { SyncEngine, SyncEngineContext } from "./sync-engine"
import { markInitialRevealComplete, resetRevealGate } from "./reveal-gate"
import { applyWorkspaceBootstrap } from "./workspace-sync"
import {
  MockSocket,
  asSocket,
  deferred,
  makeDeps,
  makeStreamBootstrap,
  makeWorkspaceBootstrap,
} from "@/test/fixtures/sync-engine"
import type { Draft, StreamPreviewHistoryBatchResponse, SyncCatchUpEntry, WorkspaceBootstrap } from "@threahq/types"
import { enqueueOperation } from "./operation-queue"

const engines: SyncEngine[] = []
const releases: Array<() => void> = []
const tracked: Array<Promise<unknown>> = []
const spies: Array<{ mockRestore: () => void }> = []
beforeEach(async () => {
  resetRevealGate()
  await Promise.all([
    db.workspaces.clear(),
    db.events.clear(),
    db.streams.clear(),
    db.streamMemberships.clear(),
    db.syncCursors.clear(),
    db.unreadState.clear(),
    db.workspaceUsers.clear(),
    db.dmPeers.clear(),
    db.workspaceMetadata.clear(),
    db.sidebarConfigs.clear(),
    db.userPreferences.clear(),
    db.streamReadState.clear(),
    db.pendingOperations.clear(),
    db.drafts.clear(),
  ])
})
// Order is load-bearing: held responses are released and in-flight work settles
// against a live engine. Destroying first would change what late responses hit.
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(tracked.splice(0))
  for (const spy of spies.splice(0)) spy.mockRestore()
  cleanup()
  for (const engine of engines.splice(0)) engine.destroy()
})
function PreviewSurface({ streamIds }: { streamIds: string[] }) {
  useStreamWarmup(streamIds)
  return null
}
function surface(engine: SyncEngine, streamIds: string[]) {
  return createElement(SyncEngineContext.Provider, { value: engine }, createElement(PreviewSurface, { streamIds }))
}
const depsAtHead = (head: string) => ({
  ...makeDeps(),
  syncService: { catchUp: vi.fn(async () => ({ entries: [], head })) },
})
function createEngine(deps: ConstructorParameters<typeof SyncEngine>[0]) {
  const engine = new SyncEngine(deps)
  engines.push(engine)
  return engine
}
async function setup() {
  const deps = depsAtHead("0")
  const engine = createEngine(deps)
  const socket = new MockSocket()
  await engine.onConnect(asSocket(socket))
  return { deps, engine, socket }
}
function disconnect(engine: SyncEngine, socket: MockSocket) {
  socket.connected = false
  engine.onDisconnect()
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 30))
function track<T>(work: Promise<T>) {
  tracked.push(work)
  return work
}
function hold<T = void>(fallback?: T) {
  const gate = deferred<T>()
  releases.push(() => gate.resolve(fallback as T))
  return gate
}
function holdSnapshot(deps: Pick<ReturnType<typeof makeDeps>, "workspaceService">, { once }: { once: boolean }) {
  const workspace: WorkspaceBootstrap = { ...makeWorkspaceBootstrap(), syncHead: "10" }
  const snapshot = hold(workspace)
  const bootstrap = deps.workspaceService.bootstrap
  if (once) bootstrap.mockImplementationOnce(() => snapshot.promise).mockResolvedValue(workspace)
  else bootstrap.mockImplementation(() => snapshot.promise)
  return { snapshot, workspace }
}
function holdBootstraps(deps: Pick<ReturnType<typeof makeDeps>, "streamService">, gate: { promise: Promise<void> }) {
  const original = deps.streamService.bootstrap.getMockImplementation()!
  const lanes = { active: 0, peak: 0 }
  deps.streamService.bootstrap.mockImplementation(async (...args) => {
    lanes.active++
    lanes.peak = Math.max(lanes.peak, lanes.active)
    await gate.promise
    lanes.active--
    return original(...args)
  })
  return lanes
}
function holdAbortableBootstraps(
  deps: Pick<ReturnType<typeof makeDeps>, "streamService">,
  gate: { promise: Promise<void> }
) {
  const original = deps.streamService.bootstrap.getMockImplementation()!
  const lanes = { active: 0, peak: 0 }
  const signals: AbortSignal[] = []
  deps.streamService.bootstrap.mockImplementation(async (...args) => {
    const signal = args[2]!.signal!
    signals.push(signal)
    lanes.active++
    lanes.peak = Math.max(lanes.peak, lanes.active)
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        gate.promise.then(() => {
          signal.removeEventListener("abort", abort)
          resolve()
        })
      })
      const response = await original(...args)
      response.events = response.events.map((event) => ({ ...event, id: `${event.id}_${args[1]}` }))
      return response
    } finally {
      lanes.active--
    }
  })
  return { lanes, signals }
}

function interceptPreviewWrite(onWrite: () => void) {
  const put = eventWrites.putEventsBounded
  let triggered = false
  const spy = vi.spyOn(eventWrites, "putEventsBounded").mockImplementation((table, rows) => {
    return put(table, rows).then(() => {
      if (triggered || !rows.some((event) => event.id === "evt_stream_a_2")) return
      triggered = true
      const transaction = Dexie.currentTransaction
      expect({
        active: transaction?.active,
        mode: transaction?.mode,
        sameDatabase: transaction?.db === getActiveDb(),
      }).toEqual({ active: true, mode: "readwrite", sameDatabase: true })
      return transaction!
        .table("events")
        .get("evt_stream_a_2")
        .then((event) => {
          expect(event).toMatchObject({ id: "evt_stream_a_2", streamId: "stream_a" })
          // UI ownership changes run outside the preview's transaction context.
          Dexie.ignoreTransaction(onWrite)
        })
    })
  })
  spies.push(spy)
  return spy
}

describe("preview history recovery", () => {
  it.each(["resume", "pull"])(
    "should finish preview, operation and draft setup when %s overlaps the cold snapshot",
    async (trigger) => {
      const draft: Draft = {
        id: "draft_setup",
        workspaceId: "ws_1",
        userId: "user_1",
        scope: "stream:stream_a",
        rootStreamId: null,
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Recovered draft" }] }],
        },
        contentMarkdown: "Recovered draft",
        attachmentIds: [],
        command: null,
        contextRefs: null,
        ciphertext: null,
        envelope: null,
        e2eVersion: null,
        version: 1,
        clientUpdatedAt: new Date(1000).toISOString(),
        stashedAt: null,
        createdAt: new Date(1000).toISOString(),
        updatedAt: new Date(1000).toISOString(),
      }
      const deps = {
        ...depsAtHead("10"),
        messageService: { update: vi.fn(), delete: vi.fn(async () => {}) },
        draftsService: {
          list: vi.fn(async () => ({ drafts: [draft] })),
          upsert: vi.fn(),
          resolve: vi.fn(),
          delete: vi.fn(),
        },
      }
      const { snapshot, workspace } = holdSnapshot(deps, { once: true })
      await db.streams.put({ ...makeStreamBootstrap("stream_a").stream, _cachedAt: 1 })
      await enqueueOperation("ws_1", "delete_message", { messageId: "msg_offline" })
      const engine = createEngine(deps)
      engine.warmStreams(["stream_a"])
      const connecting = track(engine.onConnect(asSocket(new MockSocket())))
      await vi.waitFor(() => expect(deps.workspaceService.bootstrap).toHaveBeenCalledOnce())
      const recovery = track(trigger === "resume" ? engine.refreshAfterConnectivityResume() : engine.refreshAfterPull())
      snapshot.resolve(workspace)
      await Promise.all([connecting, recovery])
      await vi.waitFor(async () =>
        expect({
          preview: (await db.events.get("evt_stream_a_2"))?.streamId,
          pending: await db.pendingOperations.toArray(),
          draft: (await db.drafts.get(draft.id))?.contentJson,
        }).toEqual({ preview: "stream_a", pending: [], draft: draft.contentJson })
      )
      expect(deps.messageService.delete).toHaveBeenCalledWith("ws_1", "msg_offline")
      expect(deps.draftsService.list).toHaveBeenCalledExactlyOnceWith("ws_1")
      expect(deps.streamService.previewHistory.mock.calls.map((call) => call[1])).toEqual([["stream_a"]])
    }
  )

  it.each(["resume", "pull"])(
    "should keep the newer %s gate paused when same-connection setup finishes",
    async (trigger) => {
      const deps = depsAtHead("10")
      const { snapshot, workspace } = holdSnapshot(deps, { once: true })
      const required = hold()
      holdBootstraps(deps, required)
      const engine = createEngine(deps)
      const socket = new MockSocket()
      const connecting = track(engine.onConnect(asSocket(socket)))
      await vi.waitFor(() => expect(deps.workspaceService.bootstrap).toHaveBeenCalledOnce())
      engine.setCurrentStreamId("stream_required")
      const recovery = track(trigger === "resume" ? engine.refreshAfterConnectivityResume() : engine.refreshAfterPull())
      snapshot.resolve(workspace)
      await connecting
      await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalled())
      socket.trigger("workspace_user:added", {
        workspaceId: "ws_1",
        syncId: "11",
        user: { id: "user_after_setup", workspaceId: "ws_1", name: "After setup" },
      })
      await pause()
      expect({
        catchUp: deps.syncService.catchUp.mock.calls,
        user: await db.workspaceUsers.get("user_after_setup"),
      }).toEqual({ catchUp: [], user: undefined })
      required.resolve()
      await recovery
      await vi.waitFor(async () =>
        expect(await db.workspaceUsers.get("user_after_setup")).toMatchObject({ name: "After setup" })
      )
    }
  )

  it.each(["body", "terminal error"])(
    "should retire obsolete full-sweep roots before their %s settles without losing the cold snapshot",
    async (late) => {
      const deps = depsAtHead("10")
      const { snapshot, workspace } = holdSnapshot(deps, { once: false })
      const engine = createEngine(deps)
      const ids = Array.from({ length: 12 }, (_, i) => `stream_full_old_${i}`)
      const held = hold()
      const original = deps.streamService.bootstrap.getMockImplementation()!
      deps.streamService.bootstrap.mockImplementation(async (...args) => {
        if (ids.includes(args[1])) {
          await held.promise
          if (late === "terminal error") throw new ApiError(403, "FORBIDDEN", "Forbidden")
        }
        const result = await original(...args)
        result.events = result.events.map((event) => ({ ...event, id: `${event.id}_${args[1]}` }))
        return result
      })
      engine.setBoardStreamIds(ids)
      const socket = new MockSocket()
      const first = track(engine.onConnect(asSocket(socket)))
      const claim = engine.claimWorkspaceBootstrap()
      await vi.waitFor(() =>
        expect(deps.streamService.bootstrap.mock.calls.map((call) => call[1])).toEqual(ids.slice(0, 6))
      )
      disconnect(engine, socket)
      engine.setBoardStreamIds([])
      engine.setCurrentStreamId("stream_new_current")
      const newest = new MockSocket()
      const next = track(engine.onConnect(asSocket(newest)))
      await pause()
      expect({ cursor: engine.getSyncCursor(), catchUp: deps.syncService.catchUp.mock.calls.length }).toEqual({
        cursor: null,
        catchUp: 0,
      })
      snapshot.resolve(workspace)
      await vi.waitFor(() => expect(deps.syncService.catchUp).toHaveBeenCalledOnce(), { timeout: 700 })
      await Promise.all([first, next])
      expect(await claim).toMatchObject({ workspace: { id: "ws_1" }, syncHead: "10" })
      expect({
        ids: deps.streamService.bootstrap.mock.calls.map((call) => call[1]),
        aborted: deps.streamService.bootstrap.mock.calls.slice(0, 6).map((call) => call[2]?.signal?.aborted),
        cursor: engine.getSyncCursor(),
        workspace: deps.syncStatus.get("workspace:ws_1"),
        errors: ids.map((id) => deps.syncStatus.getError(`stream:${id}`)),
      }).toEqual({
        ids: [...ids.slice(0, 6), "stream_new_current"],
        aborted: Array(6).fill(true),
        cursor: "10",
        workspace: "synced",
        errors: ids.map(() => null),
      })
      newest.trigger("workspace_user:added", {
        workspaceId: "ws_1",
        syncId: "11",
        user: { id: "user_after_full_retirement", workspaceId: "ws_1", name: "Recovered" },
      })
      await vi.waitFor(async () => expect(await db.workspaceUsers.get("user_after_full_retirement")).toBeTruthy())
      held.resolve()
      await pause()
      expect({
        streams: await db.streams.bulkGet(ids),
        events: await db.events.bulkGet(ids.map((id) => `evt_2_${id}`)),
        errors: ids.map((id) => deps.syncStatus.getError(`stream:${id}`)),
        cursor: engine.getSyncCursor(),
        workspace: deps.syncStatus.get("workspace:ws_1"),
      }).toEqual({
        streams: ids.map(() => undefined),
        events: ids.map(() => undefined),
        errors: ids.map(() => null),
        cursor: "11",
        workspace: "synced",
      })
    }
  )

  it.each(["current", "URL-visible", "claimed", "board", "panel"])(
    "should retain a full-sweep root shared with %s demand across recovery generations",
    async (owner) => {
      const deps = depsAtHead("10")
      deps.workspaceService.bootstrap.mockResolvedValue({ ...makeWorkspaceBootstrap(), syncHead: "10" })
      const engine = createEngine(deps)
      const held = hold()
      const original = deps.streamService.bootstrap.getMockImplementation()!
      deps.streamService.bootstrap.mockImplementation(async (...args) => {
        if (args[1] === "stream_full_shared") await held.promise
        return original(...args)
      })
      engine.setBoardStreamIds(["stream_full_shared"])
      const socket = new MockSocket()
      const first = track(engine.onConnect(asSocket(socket)))
      const workspaceClaim = engine.claimWorkspaceBootstrap()
      await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledOnce())
      const signal = deps.streamService.bootstrap.mock.calls[0][2]?.signal
      let streamClaim: ReturnType<SyncEngine["claimStreamBootstrap"]> = null
      if (owner === "current") engine.setCurrentStreamId("stream_full_shared")
      if (owner === "URL-visible") engine.setVisibleStreamIds(["stream_full_shared"])
      if (owner === "claimed") streamClaim = engine.claimStreamBootstrap("stream_full_shared")
      if (owner === "panel") engine.setPanelStreamIds(["stream_full_shared"])
      disconnect(engine, socket)
      if (owner !== "board") engine.setBoardStreamIds([])
      const next = track(engine.onConnect(asSocket(new MockSocket())))
      await pause()
      expect({
        aborted: signal?.aborted,
        calls: deps.streamService.bootstrap.mock.calls.map((call) => call[1]),
        cursor: engine.getSyncCursor(),
        catchUp: deps.syncService.catchUp.mock.calls.length,
      }).toEqual({
        aborted: false,
        calls: ["stream_full_shared"],
        cursor: null,
        catchUp: 0,
      })
      held.resolve()
      await Promise.all([first, next])
      if (streamClaim) await expect(streamClaim).resolves.toMatchObject({ stream: { id: "stream_full_shared" } })
      expect(await workspaceClaim).toMatchObject({ syncHead: "10" })
      await vi.waitFor(() => expect(deps.syncService.catchUp).toHaveBeenCalledOnce())
      expect({
        cursor: engine.getSyncCursor(),
        stream: (await db.streams.get("stream_full_shared"))?.id,
        error: deps.syncStatus.getError("stream:stream_full_shared"),
      }).toEqual({ cursor: "10", stream: "stream_full_shared", error: null })
    }
  )

  it("should stop waiting for an exclusively obsolete full-sweep room join", async () => {
    const deps = depsAtHead("10")
    deps.workspaceService.bootstrap.mockResolvedValue({ ...makeWorkspaceBootstrap(), syncHead: "10" })
    const engine = createEngine(deps)
    const joined = hold()
    const socket = new MockSocket()
    socket.joinInterceptor = async (room) => {
      if (room === "ws:ws_1:stream:stream_full_join") await joined.promise
    }
    engine.setBoardStreamIds(["stream_full_join"])
    const first = track(engine.onConnect(asSocket(socket)))
    await vi.waitFor(() =>
      expect(
        socket.emittedEvents.some(
          ({ event, args }) => event === "join" && args[0] === "ws:ws_1:stream:stream_full_join"
        )
      ).toBe(true)
    )
    disconnect(engine, socket)
    engine.setBoardStreamIds([])
    const next = track(engine.onConnect(asSocket(new MockSocket())))
    await vi.waitFor(() => expect(deps.syncService.catchUp).toHaveBeenCalledOnce(), { timeout: 700 })
    await Promise.all([first, next])
    expect({ requests: deps.streamService.bootstrap.mock.calls, cursor: engine.getSyncCursor() }).toEqual({
      requests: [],
      cursor: "10",
    })
  })

  it("should preserve a cancelled full root's cached metadata rather than treating it as missing", async () => {
    const deps = depsAtHead("10")
    const { snapshot, workspace } = holdSnapshot(deps, { once: false })
    const cached = { ...makeStreamBootstrap("stream_full_cached").stream, displayName: "cached title", _cachedAt: 1 }
    await db.streams.put(cached)
    const engine = createEngine(deps)
    engine.setBoardStreamIds([cached.id])
    const socket = new MockSocket()
    const first = track(engine.onConnect(asSocket(socket)))
    await vi.waitFor(() => expect(deps.streamService.bootstrap.mock.results[0]?.type).toBe("return"))
    await deps.streamService.bootstrap.mock.results[0].value
    disconnect(engine, socket)
    engine.setBoardStreamIds([])
    const next = track(engine.onConnect(asSocket(new MockSocket())))
    snapshot.resolve(workspace)
    await Promise.all([first, next])
    expect({
      name: (await db.streams.get(cached.id))?.displayName,
      event: await db.events.get("evt_2"),
      query: deps.queryClient.getQueryData(streamKeys.bootstrap("ws_1", cached.id)),
      error: deps.syncStatus.getError(`stream:${cached.id}`),
    }).toEqual({ name: "cached title", event: undefined, query: undefined, error: null })
  })

  it("should exclude a full root retired while completed responses wait for the cached reveal", async () => {
    const deps = depsAtHead("10")
    const workspace = await deps.workspaceService.bootstrap()
    await applyWorkspaceBootstrap("ws_1", workspace)
    deps.workspaceService.bootstrap.mockResolvedValue({ ...workspace, syncHead: "10" })
    releases.push(() => markInitialRevealComplete("ws_1"))
    const engine = createEngine(deps)
    engine.setBoardStreamIds(["stream_full_reveal"])
    const socket = new MockSocket()
    const first = track(engine.onConnect(asSocket(socket)))
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledOnce())
    await deps.streamService.bootstrap.mock.results[0].value
    await pause()
    expect(await db.events.get("evt_2")).toBeUndefined()
    disconnect(engine, socket)
    engine.setBoardStreamIds([])
    const next = track(engine.onConnect(asSocket(new MockSocket())))
    markInitialRevealComplete("ws_1")
    await Promise.all([first, next])
    expect({
      stream: await db.streams.get("stream_full_reveal"),
      event: await db.events.get("evt_2"),
      query: deps.queryClient.getQueryData(streamKeys.bootstrap("ws_1", "stream_full_reveal")),
      error: deps.syncStatus.getError("stream:stream_full_reveal"),
      cursor: engine.getSyncCursor(),
    }).toEqual({ stream: undefined, event: undefined, query: undefined, error: null, cursor: "10" })
  })

  it("should keep six cancellable cold transports across serialized full-sweep generations", async () => {
    const deps = makeDeps()
    const engine = createEngine(deps)
    const held = hold()
    const { lanes } = holdAbortableBootstraps(deps, held)
    const oldIds = Array.from({ length: 12 }, (_, i) => `stream_full_transport_old_${i}`)
    const newIds = Array.from({ length: 12 }, (_, i) => `stream_full_transport_new_${i}`)
    engine.setBoardStreamIds(oldIds)
    const socket = new MockSocket()
    const first = track(engine.onConnect(asSocket(socket)))
    await vi.waitFor(() =>
      expect(deps.streamService.bootstrap.mock.calls.map((call) => call[1])).toEqual(oldIds.slice(0, 6))
    )
    disconnect(engine, socket)
    engine.setBoardStreamIds(newIds)
    const next = track(engine.onConnect(asSocket(new MockSocket())))
    await vi.waitFor(() =>
      expect(deps.streamService.bootstrap.mock.calls.map((call) => call[1])).toEqual([
        ...oldIds.slice(0, 6),
        ...newIds.slice(0, 6),
      ])
    )
    expect({ ...lanes, workspaceCalls: deps.workspaceService.bootstrap.mock.calls.length }).toEqual({
      active: 6,
      peak: 6,
      workspaceCalls: 2,
    })
    held.resolve()
    await Promise.all([first, next])
    expect({ ids: deps.streamService.bootstrap.mock.calls.map((call) => call[1]), ...lanes }).toEqual({
      ids: [...oldIds.slice(0, 6), ...newIds],
      active: 0,
      peak: 6,
    })
    expect((await db.streams.bulkGet(newIds)).map((stream) => stream?.id)).toEqual(newIds)
  })

  it("should abort failed-sweep transports before admitting replacement board recovery", async () => {
    const deps = depsAtHead("10")
    const failedSnapshot = hold()
    deps.workspaceService.bootstrap.mockImplementationOnce(async () => {
      await failedSnapshot.promise
      throw new Error("Workspace snapshot failed")
    })
    const held = hold()
    const { lanes, signals } = holdAbortableBootstraps(deps, held)
    const engine = createEngine(deps)
    const oldIds = Array.from({ length: 12 }, (_, i) => `stream_failed_sweep_${i}`)
    const newIds = Array.from({ length: 12 }, (_, i) => `stream_after_failure_${i}`)
    engine.setBoardStreamIds(oldIds)
    const connecting = track(engine.onConnect(asSocket(new MockSocket())))
    await vi.waitFor(() => expect(signals).toHaveLength(6))
    engine.setBoardStreamIds([])
    const fallbackRead = hold()
    const fallbackStarted = hold()
    const workspaces = getActiveDb().workspaces
    const getWorkspace = workspaces.get.bind(workspaces)
    spies.push(
      vi.spyOn(workspaces, "get").mockImplementationOnce((key) => {
        fallbackStarted.resolve()
        return Dexie.Promise.resolve(fallbackRead.promise).then(() => getWorkspace(key))
      })
    )
    failedSnapshot.resolve()
    await fallbackStarted.promise
    expect(signals.map((signal) => signal.aborted)).toEqual(Array(6).fill(true))
    fallbackRead.resolve()
    await connecting
    engine.setBoardStreamIds(newIds)
    await vi.waitFor(() => expect(signals).toHaveLength(12))
    expect(lanes).toEqual({ active: 6, peak: 6 })
    held.resolve()
    await vi.waitFor(async () => expect((await db.streams.bulkGet(newIds)).map((stream) => stream?.id)).toEqual(newIds))
    expect({ ids: deps.streamService.bootstrap.mock.calls.map((call) => call[1]), ...lanes }).toEqual({
      ids: [...oldIds.slice(0, 6), ...newIds],
      active: 0,
      peak: 6,
    })
    expect(await db.events.bulkGet(oldIds.map((id) => `evt_2_${id}`))).toEqual(oldIds.map(() => undefined))
  })

  it("should preserve a queued force-full upgrade after retiring an obsolete cold sweep", async () => {
    const deps = depsAtHead("10")
    const { snapshot, workspace } = holdSnapshot(deps, { once: true })
    const held = hold()
    holdBootstraps(deps, held)
    const engine = createEngine(deps)
    engine.setBoardStreamIds(["stream_full_upgrade_old"])
    const socket = new MockSocket()
    const first = track(engine.onConnect(asSocket(socket)))
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledOnce())
    disconnect(engine, socket)
    engine.setBoardStreamIds([])
    const next = track(engine.onConnect(asSocket(new MockSocket())))
    await pause()
    const pull = track(engine.refreshAfterPull())
    snapshot.resolve(workspace)
    await vi.waitFor(() =>
      expect(deps.workspaceService.bootstrap.mock.calls).toEqual([
        ["ws_1", { fresh: false }],
        ["ws_1", { fresh: true }],
      ])
    )
    await Promise.all([first, next, pull])
    expect({
      ids: deps.streamService.bootstrap.mock.calls.map((call) => call[1]),
      cursor: engine.getSyncCursor(),
      error: deps.syncStatus.getError("stream:stream_full_upgrade_old"),
    }).toEqual({ ids: ["stream_full_upgrade_old"], cursor: "10", error: null })
  })

  it.each(["destroy", "account change"])("should fence late full-sweep responses after %s", async (change) => {
    const deps = makeDeps()
    const workspace = await deps.workspaceService.bootstrap()
    const snapshot = hold(workspace)
    deps.workspaceService.bootstrap.mockImplementation(() => snapshot.promise)
    const held = hold()
    holdBootstraps(deps, held)
    const engine = createEngine(deps)
    engine.setBoardStreamIds(["stream_full_teardown"])
    const first = track(engine.onConnect(asSocket(new MockSocket())))
    const claim = engine.claimWorkspaceBootstrap()
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledOnce())
    if (change === "destroy") engine.destroy()
    else eventWrites.bumpAccountGeneration()
    snapshot.resolve(workspace)
    held.resolve()
    await first
    await pause()
    expect({
      workspace: await db.workspaces.get("ws_1"),
      stream: await db.streams.get("stream_full_teardown"),
      cache: deps.queryClient.getQueryData(streamKeys.bootstrap("ws_1", "stream_full_teardown")),
      claim: await claim,
    }).toEqual({ workspace: undefined, stream: undefined, cache: undefined, claim: null })
  })

  it("should recover a new current stream and deliver live updates before obsolete board requests settle", async () => {
    const deps = depsAtHead("10")
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const engine = createEngine(deps)
    const firstSocket = new MockSocket()
    const held = deferred<void>()
    const oldIds = Array.from({ length: 6 }, (_, i) => `stream_obsolete_${i}`)
    let reconnect: Promise<void> | undefined
    try {
      await engine.onConnect(asSocket(firstSocket))
      await vi.waitFor(() => expect(deps.syncService.catchUp).toHaveBeenCalled())
      const liveStream = { ...makeStreamBootstrap("stream_live").stream, displayName: "before" }
      await db.streams.put({ ...liveStream, _cachedAt: Date.now() })
      deps.queryClient.setQueryData(streamKeys.detail("ws_1", "stream_live"), liveStream)
      const original = deps.streamService.bootstrap.getMockImplementation()!
      deps.streamService.bootstrap.mockImplementation(async (...args) => {
        if (oldIds.includes(args[1])) await held.promise
        const result = await original(...args)
        result.events = result.events.map((event) => ({ ...event, id: `${event.id}_${args[1]}` }))
        return result
      })
      engine.setBoardStreamIds(oldIds)
      await vi.waitFor(() => expect(deps.streamService.bootstrap.mock.calls.map((call) => call[1])).toEqual(oldIds))
      disconnect(engine, firstSocket)
      engine.setBoardStreamIds([])
      engine.setCurrentStreamId("stream_new_current")
      deps.syncService.catchUp.mockClear()
      const nextSocket = new MockSocket()
      reconnect = engine.onConnect(asSocket(nextSocket))
      await vi.waitFor(() =>
        expect(nextSocket.emittedEvents.some(({ event, args }) => event === "join" && args[0] === "ws:ws_1")).toBe(true)
      )
      nextSocket.trigger("stream:updated", {
        workspaceId: "ws_1",
        syncId: "11",
        stream: { ...liveStream, displayName: "after" },
      })
      await vi.waitFor(
        () =>
          expect({
            bootstrapIds: deps.streamService.bootstrap.mock.calls.map((call) => call[1]),
            catchUpCalls: deps.syncService.catchUp.mock.calls.length,
            liveName: deps.queryClient.getQueryData<{ displayName: string }>(streamKeys.detail("ws_1", "stream_live"))
              ?.displayName,
            workspaceStatus: deps.syncStatus.get("workspace:ws_1"),
          }).toEqual({
            bootstrapIds: [...oldIds, "stream_new_current"],
            catchUpCalls: 1,
            liveName: "after",
            workspaceStatus: "synced",
          }),
        { timeout: 700, interval: 10 }
      )
      expect(deps.streamService.bootstrap.mock.calls.slice(0, 6).map((call) => call[2]?.signal?.aborted)).toEqual(
        Array(6).fill(true)
      )
      held.resolve()
      await reconnect
      await pause()
      expect(await db.streams.bulkGet(oldIds)).toEqual(oldIds.map(() => undefined))
    } finally {
      // Obsolete bodies must settle against a live engine before destruction.
      held.resolve()
      await reconnect
      await pause()
      engine.destroy()
    }
  }, 10000)

  it("should keep the newer reconnect gate paused when an older reconnect retires", async () => {
    const { deps, engine, socket } = await setup()
    await vi.waitFor(() => expect(deps.syncService.catchUp).toHaveBeenCalled())
    const currentHeld = hold()
    const oldHeld = hold()
    const original = deps.streamService.bootstrap.getMockImplementation()!
    deps.streamService.bootstrap.mockImplementation(async (...args) => {
      await (args[1] === "stream_required" ? currentHeld.promise : oldHeld.promise)
      return original(...args)
    })
    const live = { ...makeStreamBootstrap("stream_live").stream, displayName: "before" }
    deps.queryClient.setQueryData(streamKeys.detail("ws_1", "stream_live"), live)
    disconnect(engine, socket)
    engine.setBoardStreamIds(Array.from({ length: 12 }, (_, i) => `stream_retiring_${i}`))
    const middleSocket = new MockSocket()
    const older = track(engine.onConnect(asSocket(middleSocket)))
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledTimes(6))
    disconnect(engine, middleSocket)
    engine.setBoardStreamIds([])
    engine.setCurrentStreamId("stream_required")
    deps.syncService.catchUp.mockClear()
    const newestSocket = middleSocket
    newestSocket.connected = true
    const newer = track(engine.onConnect(asSocket(newestSocket)))
    await vi.waitFor(() =>
      expect(deps.streamService.bootstrap.mock.calls.map((call) => call[1])).toContain("stream_required")
    )
    newestSocket.trigger("stream:updated", {
      workspaceId: "ws_1",
      syncId: "11",
      stream: { ...live, displayName: "after" },
    })
    await older
    await pause()
    expect({
      catchUp: deps.syncService.catchUp.mock.calls.length,
      live: deps.queryClient.getQueryData<{ displayName: string }>(streamKeys.detail("ws_1", "stream_live"))
        ?.displayName,
      workspace: deps.syncStatus.get("workspace:ws_1"),
    }).toEqual({ catchUp: 0, live: "before", workspace: "syncing" })
    currentHeld.resolve()
    await newer
    await vi.waitFor(() =>
      expect({
        catchUp: deps.syncService.catchUp.mock.calls.length,
        live: deps.queryClient.getQueryData<{ displayName: string }>(streamKeys.detail("ws_1", "stream_live"))
          ?.displayName,
      }).toEqual({ catchUp: 1, live: "after" })
    )
  })

  it.each(["current", "URL-visible"])(
    "should retain a board request promoted to %s demand while reconnect recovers other roots",
    async (surface) => {
      const { deps, engine, socket } = await setup()
      await vi.waitFor(() => expect(deps.syncService.catchUp).toHaveBeenCalled())
      const held = hold()
      const original = deps.streamService.bootstrap.getMockImplementation()!
      deps.streamService.bootstrap.mockImplementation(async (...args) => {
        if (args[1] === "stream_shared") await held.promise
        const response = await original(...args)
        response.events = response.events.map((event) => ({ ...event, id: `${event.id}_${args[1]}` }))
        return response
      })
      engine.setBoardStreamIds(["stream_shared"])
      await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledOnce())
      const signal = deps.streamService.bootstrap.mock.calls[0][2]!.signal!
      if (surface === "current") engine.setCurrentStreamId("stream_shared")
      else engine.setVisibleStreamIds(["stream_shared"])
      disconnect(engine, socket)
      engine.setBoardStreamIds(["stream_other"])
      deps.syncService.catchUp.mockClear()
      const reconnect = track(engine.onConnect(asSocket(new MockSocket())))
      await vi.waitFor(async () => expect(await db.streams.get("stream_other")).toBeTruthy())
      expect({
        aborted: signal.aborted,
        sharedRequests: deps.streamService.bootstrap.mock.calls.filter((call) => call[1] === "stream_shared").length,
        catchUp: deps.syncService.catchUp.mock.calls.length,
      }).toEqual({ aborted: false, sharedRequests: 1, catchUp: 0 })
      held.resolve()
      await reconnect
      await vi.waitFor(() => expect(deps.syncService.catchUp).toHaveBeenCalledOnce())
      expect({
        stream: (await db.streams.get("stream_shared"))?.id,
        status: deps.syncStatus.get("stream:stream_shared"),
        workspace: deps.syncStatus.get("workspace:ws_1"),
      }).toEqual({ stream: "stream_shared", status: "synced", workspace: "synced" })
    }
  )

  it.each(
    ["reconnect", "resume"].flatMap((trigger) =>
      ["current", "URL-visible", "board to current", "board to URL-visible"].map((demand) => [trigger, demand])
    )
  )("should recover %s with retained %s demand when initial cursor seeding failed", async (trigger, demand) => {
    const streamId = "stream_retained_gap"
    let gapCommitted = false
    const gap: SyncCatchUpEntry = {
      syncId: "11",
      eventType: "message:created",
      payload: { workspaceId: "ws_1", streamId, event: makeStreamBootstrap(streamId, "3").events[0] },
      createdAt: new Date().toISOString(),
    }
    const deps = {
      ...makeDeps(),
      syncService: {
        catchUp: vi
          .fn(async (_workspaceId: string, params: { after: string }) => ({
            entries: gapCommitted && BigInt(params.after) < 11n ? [gap] : [],
            head: gapCommitted ? "11" : "10",
          }))
          .mockRejectedValueOnce(new Error("Initial sync head unavailable")),
      },
    }
    deps.workspaceService.bootstrap
      .mockRejectedValueOnce(new Error("Initial workspace snapshot unavailable"))
      .mockImplementation(async () => ({ ...makeWorkspaceBootstrap(), syncHead: gapCommitted ? "11" : "10" }))
    const held = hold()
    const lanes = { active: 0, peak: 0 }
    deps.streamService.bootstrap.mockImplementation(async (_workspaceId, id, params) => {
      const response = makeStreamBootstrap(id, params?.after ? "3" : "2")
      lanes.active++
      lanes.peak = Math.max(lanes.peak, lanes.active)
      try {
        if (!params?.after) await held.promise
        return response
      } finally {
        lanes.active--
      }
    })
    const engine = createEngine(deps)
    const socket = new MockSocket()
    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(deps.syncService.catchUp).toHaveBeenCalledOnce())
    expect(engine.getSyncCursor()).toBeNull()
    if (demand.startsWith("board")) engine.setBoardStreamIds([streamId])
    else if (demand === "current") engine.setCurrentStreamId(streamId)
    else engine.setVisibleStreamIds([streamId])
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledOnce())
    if (demand === "board to current") engine.setCurrentStreamId(streamId)
    if (demand === "board to URL-visible") engine.setVisibleStreamIds([streamId])
    if (trigger === "reconnect") disconnect(engine, socket)
    gapCommitted = true
    const recovery = track(
      trigger === "reconnect" ? engine.onConnect(asSocket(new MockSocket())) : engine.refreshAfterConnectivityResume()
    )
    await vi.waitFor(() => expect(deps.syncStatus.get("workspace:ws_1")).toBe("syncing"))
    expect(deps.streamService.bootstrap).toHaveBeenCalledOnce()
    held.resolve()
    await recovery
    await vi.waitFor(() => expect(engine.getSyncCursor()).toBe("11"))
    expect({
      sequences: (await db.events.where("streamId").equals(streamId).sortBy("_sequenceNum")).map(
        (event) => event.sequence
      ),
      cursors: deps.streamService.bootstrap.mock.calls.map((call) => call[2]?.after ?? null),
      status: deps.syncStatus.get(`stream:${streamId}`),
      ...lanes,
    }).toEqual({ sequences: ["2", "3"], cursors: [null, "2"], status: "synced", active: 0, peak: 1 })
  })

  it("should leave a demoted navigation follow-up to cancellable board recovery", async () => {
    const streamId = "stream_demoted"
    const deps = depsAtHead("10")
    const engine = createEngine(deps)
    const socket = new MockSocket()
    await engine.onConnect(asSocket(socket))
    const oldBody = hold<ReturnType<typeof makeStreamBootstrap>>()
    const freshBody = hold<ReturnType<typeof makeStreamBootstrap>>()
    deps.streamService.bootstrap
      .mockImplementationOnce(() => oldBody.promise)
      .mockImplementation(() => freshBody.promise)
    engine.setCurrentStreamId(streamId)
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledOnce())
    engine.setBoardStreamIds([streamId])
    disconnect(engine, socket)
    const newSocket = new MockSocket()
    const reconnect = track(engine.onConnect(asSocket(newSocket)))
    engine.setVisibleStreamIds([streamId])
    engine.setCurrentStreamId(undefined)
    engine.setVisibleStreamIds([])
    await vi.waitFor(() => expect(deps.syncStatus.get("workspace:ws_1")).toBe("syncing"))
    oldBody.resolve(makeStreamBootstrap(streamId, "2"))
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledTimes(2))
    const params = deps.streamService.bootstrap.mock.calls[1][2]
    expect({ after: params?.after, cancellable: params?.signal instanceof AbortSignal }).toEqual({
      after: "2",
      cancellable: true,
    })
    engine.setBoardStreamIds([])
    disconnect(engine, newSocket)
    freshBody.resolve(makeStreamBootstrap(streamId, "3"))
    await reconnect
    expect({
      aborted: params?.signal?.aborted,
      sequences: (await db.events.where("streamId").equals(streamId).sortBy("_sequenceNum")).map(
        (event) => event.sequence
      ),
    }).toEqual({ aborted: true, sequences: ["2"] })
  })

  it("should retry the same board ID without borrowing or applying its retired response", async () => {
    const { deps, engine, socket } = await setup()
    const held = hold(makeStreamBootstrap("stream_retry"))
    deps.streamService.bootstrap.mockImplementationOnce(() => held.promise)
    engine.setBoardStreamIds(["stream_retry"])
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledOnce())
    const signal = deps.streamService.bootstrap.mock.calls[0][2]!.signal!
    disconnect(engine, socket)
    const reconnect = track(engine.onConnect(asSocket(new MockSocket())))
    await vi.waitFor(async () => expect(await db.streams.get("stream_retry")).toBeTruthy())
    await reconnect
    expect({ aborted: signal.aborted, requests: deps.streamService.bootstrap.mock.calls.length }).toEqual({
      aborted: true,
      requests: 2,
    })
    const stale = makeStreamBootstrap("stream_retry", "99")
    stale.stream.displayName = "obsolete"
    held.resolve(stale)
    await pause()
    expect({
      name: (await db.streams.get("stream_retry"))?.displayName,
      obsoleteEvent: await db.events.get("evt_99"),
      cacheName: deps.queryClient.getQueryData<ReturnType<typeof makeStreamBootstrap>>(
        streamKeys.bootstrap("ws_1", "stream_retry")
      )?.stream.displayName,
      status: deps.syncStatus.get("stream:stream_retry"),
    }).toEqual({ name: null, obsoleteEvent: undefined, cacheName: null, status: "synced" })
  })

  it("should abort exclusive transports before restarting six cold lanes and discard queued old roots", async () => {
    const { deps, engine, socket } = await setup()
    const held = hold()
    const { lanes, signals } = holdAbortableBootstraps(deps, held)
    const oldIds = Array.from({ length: 20 }, (_, i) => `stream_old_${i}`)
    const newIds = Array.from({ length: 12 }, (_, i) => `stream_next_${i}`)
    engine.setBoardStreamIds(oldIds)
    engine.setPanelStreamIds(["stream_old_queued_panel"])
    await vi.waitFor(() => expect(signals).toHaveLength(6))
    disconnect(engine, socket)
    engine.setBoardStreamIds(newIds)
    engine.setPanelStreamIds([])
    const reconnect = track(engine.onConnect(asSocket(new MockSocket())))
    await vi.waitFor(() => expect(signals).toHaveLength(12))
    expect({ aborted: signals.slice(0, 6).map((signal) => signal.aborted), ...lanes }).toEqual({
      aborted: Array(6).fill(true),
      active: 6,
      peak: 6,
    })
    held.resolve()
    await reconnect
    expect({ ids: deps.streamService.bootstrap.mock.calls.map((call) => call[1]), ...lanes }).toEqual({
      ids: [...oldIds.slice(0, 6), ...newIds],
      peak: 6,
      active: 0,
    })
  })

  it("should ignore a delayed full board response after its account generation changes", async () => {
    const { deps, engine } = await setup()
    const held = hold(makeStreamBootstrap("stream_old_account"))
    deps.streamService.bootstrap.mockImplementationOnce(() => held.promise)
    engine.setBoardStreamIds(["stream_old_account"])
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledOnce())
    eventWrites.bumpAccountGeneration()
    held.resolve(makeStreamBootstrap("stream_old_account"))
    await pause()
    expect({
      stream: await db.streams.get("stream_old_account"),
      event: await db.events.get("evt_2"),
      cache: deps.queryClient.getQueryData(streamKeys.bootstrap("ws_1", "stream_old_account")),
    }).toEqual({ stream: undefined, event: undefined, cache: undefined })
  })

  it("should persist 120 eager histories in five bounded batches with one request in flight", async () => {
    const { deps, engine } = await setup()
    const original = deps.streamService.previewHistory.getMockImplementation()!
    let active = 0
    let peak = 0
    deps.streamService.previewHistory.mockImplementation(async (...args) => {
      active++
      peak = Math.max(peak, active)
      await pause()
      const response = await original(...args)
      active--
      return response
    })
    render(
      surface(
        engine,
        Array.from({ length: 120 }, (_, i) => `stream_preview_${i}`)
      )
    )
    await vi.waitFor(async () => expect(await db.events.count()).toBe(120), { timeout: 3000 })
    expect({ sizes: deps.streamService.previewHistory.mock.calls.map((call) => call[1].length), peak }).toEqual({
      sizes: [25, 25, 25, 25, 20],
      peak: 1,
    })
    expect(deps.streamService.bootstrap).not.toHaveBeenCalled()
  })

  it("should retain offline history but remove recovery demand when the last mounted surface closes", async () => {
    const { deps, engine, socket } = await setup()
    const mounted = render(surface(engine, ["stream_a"]))
    await vi.waitFor(async () => expect(await db.events.get("evt_stream_a_2")).toBeTruthy())
    mounted.unmount()
    deps.streamService.previewHistory.mockClear()
    disconnect(engine, socket)
    expect((await db.events.get("evt_stream_a_2"))?.payload).toMatchObject({ contentMarkdown: "new" })
    socket.connected = true
    await engine.onConnect(asSocket(socket))
    await pause()
    expect(deps.streamService.previewHistory).not.toHaveBeenCalled()
  })

  it("should coalesce declarations into the new generation when resume replaces it in the same task", async () => {
    const { deps, engine } = await setup()
    engine.warmStreams(["stream_same_task"])
    await track(engine.refreshAfterConnectivityResume())
    await vi.waitFor(async () => expect(await db.events.get("evt_stream_same_task_2")).toBeTruthy())
    expect(
      deps.streamService.previewHistory.mock.calls.map((call) => ({ ids: call[1], aborted: call[2]?.aborted }))
    ).toEqual([{ ids: ["stream_same_task"], aborted: false }])
  })

  it("should share declarations and make owner cleanup idempotent", async () => {
    const { deps, engine, socket } = await setup()
    const release = engine.warmStreams(["stream_a"])
    const other = render(surface(engine, ["stream_a"]))
    await vi.waitFor(async () => expect(await db.events.get("evt_stream_a_2")).toBeTruthy())
    release()
    release()
    deps.streamService.previewHistory.mockClear()
    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(deps.streamService.previewHistory).toHaveBeenCalledOnce())
    other.unmount()
  })

  it("should only fetch newly added rows and ignore reorders", async () => {
    const { deps, engine } = await setup()
    const mounted = render(surface(engine, ["stream_a"]))
    await vi.waitFor(async () => expect(await db.events.get("evt_stream_a_2")).toBeTruthy())
    mounted.rerender(surface(engine, ["stream_b", "stream_a"]))
    await vi.waitFor(async () => expect(await db.events.get("evt_stream_b_2")).toBeTruthy())
    mounted.rerender(surface(engine, ["stream_a", "stream_b"]))
    await pause()
    expect(deps.streamService.previewHistory.mock.calls.map((call) => call[1])).toEqual([["stream_a"], ["stream_b"]])
  })

  it("should retire disconnect work and drain a newer reconnect behind an abort-ignoring response", async () => {
    const { deps, engine, socket } = await setup()
    const original = deps.streamService.previewHistory.getMockImplementation()!
    const held = deferred<StreamPreviewHistoryBatchResponse>()
    deps.streamService.previewHistory.mockImplementationOnce(() => held.promise as ReturnType<typeof original>)
    const ids = Array.from({ length: 36 }, (_, i) => `stream_gap_${i}`)
    engine.warmStreams(ids)
    await vi.waitFor(() => expect(deps.streamService.previewHistory).toHaveBeenCalledOnce())
    const signal = deps.streamService.previewHistory.mock.calls[0][2]!
    disconnect(engine, socket)
    await pause()
    expect(signal.aborted).toBe(true)
    expect(deps.streamService.previewHistory).toHaveBeenCalledOnce()
    socket.connected = true
    await engine.onConnect(asSocket(socket))
    expect(deps.streamService.previewHistory).toHaveBeenCalledOnce()
    const stale = await original("ws_1", ids.slice(0, 25))
    for (const result of stale.results)
      if (result.status === 200) result.history.events[0].payload = { contentMarkdown: "obsolete" }
    held.resolve(stale)
    await vi.waitFor(async () => expect(await db.events.count()).toBe(36))
    expect(deps.streamService.previewHistory.mock.calls.map((call) => call[1].length)).toEqual([25, 25, 11])
    expect((await db.events.get("evt_stream_gap_0_2"))?.payload).toMatchObject({ contentMarkdown: "new" })
  })

  it("should drop queued declarations and not apply previews that become active", async () => {
    const { deps, engine } = await setup()
    const original = deps.streamService.previewHistory.getMockImplementation()!
    const held = deferred<StreamPreviewHistoryBatchResponse>()
    deps.streamService.previewHistory.mockImplementationOnce(() => held.promise as ReturnType<typeof original>)
    engine.warmStreams(["stream_a"])
    await vi.waitFor(() => expect(deps.streamService.previewHistory).toHaveBeenCalledOnce())
    const release = engine.warmStreams(["stream_dropped"])
    release()
    engine.setCurrentStreamId("stream_a")
    held.resolve(await original("ws_1", ["stream_a"]))
    await pause()
    expect(await db.events.get("evt_stream_a_2")).toBeUndefined()
    expect(deps.streamService.previewHistory).toHaveBeenCalledOnce()
  })

  it.each(["becomes active", "loses its last owner"])(
    "should keep other previews when one stream %s during its history write",
    async (change) => {
      const { deps, engine } = await setup()
      const foreground = deferred<ReturnType<typeof makeStreamBootstrap>>()
      deps.streamService.bootstrap.mockImplementationOnce(() => foreground.promise)
      let changed = false
      let release = () => {}
      const spy = interceptPreviewWrite(() => {
        changed = true
        if (change === "becomes active") engine.setCurrentStreamId("stream_a")
        else release()
      })
      const siblings = Array.from({ length: 24 }, (_, i) => (i === 0 ? "stream_b" : `stream_sibling_${i}`))
      try {
        release = engine.warmStreams(["stream_a"])
        engine.warmStreams(siblings)
        await vi.waitFor(async () => expect(await db.events.get("evt_stream_sibling_23_2")).toBeTruthy())
        expect(changed).toBe(true)
        const siblingEvents = await db.events.bulkGet(siblings.map((id) => `evt_${id}_2`))
        expect({
          cancelled: await db.events.get("evt_stream_a_2"),
          cancelledStream: await db.streams.get("stream_a"),
          siblings: siblingEvents.map((event) => event?.streamId),
          batches: deps.streamService.previewHistory.mock.calls.map((call) => call[1]),
        }).toEqual({ cancelled: undefined, cancelledStream: undefined, siblings, batches: [["stream_a", ...siblings]] })
        engine.setCurrentStreamId(undefined)
        engine.warmStreams(["stream_a"])
        await vi.waitFor(async () => expect(await db.events.get("evt_stream_a_2")).toBeTruthy())
        expect(deps.streamService.previewHistory.mock.calls.map((call) => call[1])).toEqual([
          ["stream_a", ...siblings],
          ["stream_a"],
        ])
      } finally {
        spy.mockRestore()
        foreground.resolve(makeStreamBootstrap("stream_a"))
        if (deps.streamService.bootstrap.mock.calls.length > 0) {
          await vi.waitFor(() => expect(deps.syncStatus.get("stream:stream_a")).toBe("synced"))
        }
        engine.destroy()
      }
    }
  )

  it.each(["account changes", "socket disconnects"])(
    "should roll back the current preview and stop its siblings when the %s during its history write",
    async (change) => {
      const { deps, engine, socket } = await setup()
      let changed = false
      interceptPreviewWrite(() => {
        changed = true
        if (change === "account changes") eventWrites.bumpAccountGeneration()
        else disconnect(engine, socket)
      })
      engine.warmStreams(["stream_a", "stream_b"])
      await vi.waitFor(() => expect(changed).toBe(true))
      expect({
        events: await db.events.bulkGet(["evt_stream_a_2", "evt_stream_b_2"]),
        streams: await db.streams.bulkGet(["stream_a", "stream_b"]),
      }).toEqual({ events: [undefined, undefined], streams: [undefined, undefined] })
      expect(deps.streamService.previewHistory).toHaveBeenCalledOnce()
    }
  )

  it("should recheck demand after room joins before dispatch", async () => {
    const { deps, engine, socket } = await setup()
    const joined = deferred<void>()
    socket.joinInterceptor = async (room) => {
      if (room.includes("stream_drop")) await joined.promise
    }
    const release = engine.warmStreams(["stream_drop"])
    await pause()
    release()
    joined.resolve()
    await pause()
    expect(deps.streamService.previewHistory).not.toHaveBeenCalled()
  })

  it("should cap board reconnect recovery at six and retire queued work on disconnect", async () => {
    const { deps, engine, socket } = await setup()
    const held = deferred<void>()
    const lanes = holdBootstraps(deps, held)
    engine.setBoardStreamIds(Array.from({ length: 20 }, (_, i) => `stream_board_${i}`))
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledTimes(6))
    disconnect(engine, socket)
    held.resolve()
    await pause()
    expect({ calls: deps.streamService.bootstrap.mock.calls.length, peak: lanes.peak }).toEqual({ calls: 6, peak: 6 })
    engine.setBoardStreamIds([])
    socket.connected = true
    await engine.onConnect(asSocket(socket))
    await pause()
    expect(deps.streamService.bootstrap).toHaveBeenCalledTimes(6)
  })

  it("should cap cold visible recovery at six and fetch the current stream first", async () => {
    const deps = makeDeps()
    const engine = createEngine(deps)
    engine.setCurrentStreamId("stream_current")
    engine.setVisibleStreamIds(Array.from({ length: 19 }, (_, i) => `stream_cold_${i}`))
    const held = deferred<void>()
    const lanes = holdBootstraps(deps, held)
    const connect = engine.onConnect(asSocket(new MockSocket()))
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledTimes(6))
    expect(deps.streamService.bootstrap.mock.calls[0][1]).toBe("stream_current")
    held.resolve()
    await connect
    expect({ calls: deps.streamService.bootstrap.mock.calls.length, peak: lanes.peak }).toEqual({ calls: 20, peak: 6 })
  })

  it("should preserve metadata and standalone read/counter state omitted by histories", async () => {
    const { deps, engine } = await setup()
    const response = await deps.streamService.previewHistory("ws_1", ["stream_a"])
    const result = response.results[0]
    if (result.status !== 200) throw new Error("fixture")
    const contextBag = { bag: null, refs: [] }
    await db.streams.put({ ...result.history.stream, notificationLevel: "everything", contextBag, _cachedAt: 1 })
    const read = {
      id: "ws_1:stream_a",
      workspaceId: "ws_1",
      streamId: "stream_a",
      lastReadEventId: "evt_old",
      lastReadSequence: "1",
      lastReadAt: null,
      _cachedAt: 1,
    }
    await db.streamReadState.put(read)
    const counters = await db.unreadState.get("ws_1")
    deps.streamService.previewHistory.mockClear()
    engine.warmStreams(["stream_a"])
    await vi.waitFor(async () => expect(await db.events.get("evt_stream_a_2")).toBeTruthy())
    expect(await db.streams.get("stream_a")).toMatchObject({ notificationLevel: "everything", contextBag })
    expect(await db.streamReadState.get(read.id)).toEqual(read)
    expect(await db.unreadState.get("ws_1")).toEqual(counters)
    expect(deps.queryClient.getQueryData(streamKeys.bootstrap("ws_1", "stream_a"))).toBeUndefined()
  })

  it("should preserve the entire fresh stream row and its watermark when delayed history lands", async () => {
    const { deps, engine } = await setup()
    const original = deps.streamService.previewHistory.getMockImplementation()!
    const stale = await original("ws_1", ["stream_a"])
    const result = stale.results[0]
    if (result.status !== 200) throw new Error("fixture")
    result.history.stream.messageCount = 1
    result.history.stream.messageCountRevision = 1
    const held = deferred<StreamPreviewHistoryBatchResponse>()
    deps.streamService.previewHistory.mockImplementationOnce(() => held.promise)
    engine.warmStreams(["stream_a"])
    await vi.waitFor(() => expect(deps.streamService.previewHistory).toHaveBeenCalledOnce())
    const fresh = {
      ...result.history.stream,
      displayName: "fresh title",
      description: "fresh description",
      messageCount: 42,
      messageCountRevision: 7,
      visibility: "public" as const,
      companionMode: "off" as const,
      archivedAt: new Date().toISOString(),
      notificationLevel: "everything" as const,
      contextBag: { bag: null, refs: [] },
      _cachedAt: Date.now(),
    }
    await db.streams.put(fresh)
    held.resolve(stale)
    await vi.waitFor(async () => expect(await db.events.get("evt_stream_a_2")).toBeTruthy())
    expect(await db.streams.get("stream_a")).toEqual(fresh)
  })

  it("should heal missed edits and remove deleted rows within the replacement window", async () => {
    const { deps, engine } = await setup()
    const response = await deps.streamService.previewHistory("ws_1", ["stream_a"])
    const result = response.results[0]
    if (result.status !== 200) throw new Error("fixture")
    const event = result.history.events[0]
    result.history.events = [
      { ...event, id: "evt_edited", sequence: "1", payload: { messageId: "msg_edited", contentMarkdown: "edited" } },
      { ...event, id: "evt_tail", sequence: "3" },
    ]
    result.history.latestSequence = "3"
    await db.events.bulkPut([
      {
        ...result.history.events[0],
        workspaceId: "ws_1",
        payload: { messageId: "msg_edited", contentMarkdown: "old" },
        _sequenceNum: 1,
        _cachedAt: 1,
      },
      { ...event, workspaceId: "ws_1", id: "evt_deleted", sequence: "2", _sequenceNum: 2, _cachedAt: 1 },
    ])
    deps.streamService.previewHistory.mockResolvedValueOnce(response)
    engine.warmStreams(["stream_a"])
    await vi.waitFor(async () =>
      expect((await db.events.get("evt_edited"))?.payload).toEqual({
        messageId: "msg_edited",
        contentMarkdown: "edited",
      })
    )
    expect(await db.events.get("evt_deleted")).toBeUndefined()
  })

  it("should ignore an abort-ignoring preview response after the account generation changes", async () => {
    const { deps, engine } = await setup()
    const original = deps.streamService.previewHistory.getMockImplementation()!
    const held = deferred<StreamPreviewHistoryBatchResponse>()
    deps.streamService.previewHistory.mockImplementationOnce(() => held.promise)
    engine.warmStreams(["stream_a"])
    await vi.waitFor(() => expect(deps.streamService.previewHistory).toHaveBeenCalledOnce())
    eventWrites.bumpAccountGeneration()
    held.resolve(await original("ws_1", ["stream_a"]))
    await pause()
    expect(await db.events.get("evt_stream_a_2")).toBeUndefined()
    expect(await db.streams.get("stream_a")).toBeUndefined()
  })

  it.each([401, 404])(
    "should retain cached history on whole-request %s and retry a later declaration",
    async (status) => {
      const { deps, engine } = await setup()
      engine.warmStreams(["stream_a"])
      await vi.waitFor(async () => expect(await db.events.get("evt_stream_a_2")).toBeTruthy())
      await engine.refreshAfterConnectivityResume()
      await pause()
      deps.streamService.previewHistory.mockRejectedValueOnce(new ApiError(status, "REQUEST_FAILED", "failed"))
      await engine.refreshAfterConnectivityResume()
      await pause()
      expect(deps.syncStatus.getError("stream:stream_a")).toBeNull()
      expect(await db.events.get("evt_stream_a_2")).toBeTruthy()
      const before = deps.streamService.previewHistory.mock.calls.length
      engine.warmStreams(["stream_a"])
      await vi.waitFor(() => expect(deps.streamService.previewHistory.mock.calls.length).toBe(before + 1))
    }
  )

  it("should recover the open timeline over HTTP on online resume while the socket remains disconnected", async () => {
    const { deps, engine, socket } = await setup()
    const initial = makeStreamBootstrap("stream_current", "1")
    initial.events[0].payload = { messageId: "msg_initial", contentMarkdown: "cached timeline" }
    deps.streamService.bootstrap.mockResolvedValueOnce(initial)
    engine.setCurrentStreamId("stream_current")
    await vi.waitFor(async () => expect(await db.events.get("evt_1")).toBeTruthy())
    deps.streamService.bootstrap.mockClear()
    const missed = makeStreamBootstrap("stream_current", "2")
    missed.events[0].payload = { messageId: "msg_missed", contentMarkdown: "HTTP recovered" }
    deps.streamService.bootstrap.mockResolvedValueOnce(missed)
    disconnect(engine, socket)
    await engine.refreshAfterConnectivityResume()
    expect(deps.streamService.bootstrap).toHaveBeenCalledWith("ws_1", "stream_current", { after: "1" })
    expect((await db.events.get("evt_2"))?.payload).toMatchObject({ contentMarkdown: "HTTP recovered" })
  }, 10_000)

  it("should recover a URL-visible bare panel over HTTP without recovering background board roots", async () => {
    const { deps, engine, socket } = await setup()
    deps.streamService.bootstrap.mockResolvedValueOnce(makeStreamBootstrap("stream_panel", "1"))
    engine.setVisibleStreamIds(["stream_panel"])
    await vi.waitFor(async () => expect(await db.events.get("evt_1")).toBeTruthy())
    disconnect(engine, socket)
    engine.setBoardStreamIds(["stream_background"])
    engine.setPanelStreamIds(["stream_conversation_root"])
    deps.streamService.bootstrap.mockClear()
    const missed = makeStreamBootstrap("stream_panel", "2")
    missed.events[0].payload = { messageId: "msg_panel", contentMarkdown: "panel recovered" }
    deps.streamService.bootstrap.mockResolvedValueOnce(missed)

    await engine.refreshAfterConnectivityResume()

    expect(deps.streamService.bootstrap.mock.calls).toEqual([["ws_1", "stream_panel", { after: "1" }]])
    expect((await db.events.get("evt_2"))?.payload).toMatchObject({ contentMarkdown: "panel recovered" })
  })

  it("should classify per-stream terminal errors while applying successful siblings", async () => {
    const { deps, engine } = await setup()
    const original = deps.streamService.previewHistory.getMockImplementation()!
    deps.streamService.previewHistory.mockImplementationOnce(async () => {
      const response: StreamPreviewHistoryBatchResponse = await original("ws_1", ["stream_ok"])
      response.results.push(
        { streamId: "stream_denied", status: 403, code: "FORBIDDEN" },
        { streamId: "stream_missing", status: 404, code: "NOT_FOUND" }
      )
      return response
    })
    engine.warmStreams(["stream_ok", "stream_denied", "stream_missing"])
    await vi.waitFor(async () => expect(await db.events.get("evt_stream_ok_2")).toBeTruthy())
    expect(deps.syncStatus.getError("stream:stream_denied")).toMatchObject({ status: 403 })
    expect(deps.syncStatus.getError("stream:stream_missing")).toMatchObject({ status: 404 })
  })
})
