import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { render, cleanup } from "@testing-library/react"
import { db } from "@/db/database"
import { bumpAccountGeneration } from "@/db/event-writes"
import { ApiError } from "@/api/client"
import { streamKeys } from "@/hooks/use-streams"
import { useStreamWarmup } from "@/hooks/use-stream-warmup"
import { SyncEngine, SyncEngineContext } from "./sync-engine"
import { resetRevealGate } from "./reveal-gate"
import { MockSocket, asSocket, makeDeps, makeStreamBootstrap } from "@/test/fixtures/sync-engine"
import type { StreamPreviewHistoryBatchResponse } from "@threahq/types"

const engines: SyncEngine[] = []
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
  ])
})
afterEach(() => {
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
async function setup() {
  const deps = { ...makeDeps(), syncService: { catchUp: vi.fn(async () => ({ entries: [], head: "0" })) } }
  const engine = new SyncEngine(deps)
  engines.push(engine)
  const socket = new MockSocket()
  await engine.onConnect(asSocket(socket))
  return { deps, engine, socket }
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 30))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("preview history recovery", () => {
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
    socket.connected = false
    engine.onDisconnect()
    expect((await db.events.get("evt_stream_a_2"))?.payload).toMatchObject({ contentMarkdown: "new" })
    socket.connected = true
    await engine.onConnect(asSocket(socket))
    await pause()
    expect(deps.streamService.previewHistory).not.toHaveBeenCalled()
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
    socket.connected = false
    engine.onDisconnect()
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
    let active = 0
    let peak = 0
    const original = deps.streamService.bootstrap.getMockImplementation()!
    deps.streamService.bootstrap.mockImplementation(async (...args) => {
      active++
      peak = Math.max(peak, active)
      await held.promise
      active--
      return original(...args)
    })
    engine.setBoardStreamIds(Array.from({ length: 20 }, (_, i) => `stream_board_${i}`))
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledTimes(6))
    socket.connected = false
    engine.onDisconnect()
    held.resolve()
    await pause()
    expect({ calls: deps.streamService.bootstrap.mock.calls.length, peak }).toEqual({ calls: 6, peak: 6 })
    engine.setBoardStreamIds([])
    socket.connected = true
    await engine.onConnect(asSocket(socket))
    await pause()
    expect(deps.streamService.bootstrap).toHaveBeenCalledTimes(6)
  })

  it("should cap cold visible recovery at six and fetch the current stream first", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    engines.push(engine)
    engine.setCurrentStreamId("stream_current")
    engine.setVisibleStreamIds(Array.from({ length: 19 }, (_, i) => `stream_cold_${i}`))
    const held = deferred<void>()
    const original = deps.streamService.bootstrap.getMockImplementation()!
    let active = 0
    let peak = 0
    deps.streamService.bootstrap.mockImplementation(async (...args) => {
      active++
      peak = Math.max(peak, active)
      await held.promise
      active--
      return original(...args)
    })
    const connect = engine.onConnect(asSocket(new MockSocket()))
    await vi.waitFor(() => expect(deps.streamService.bootstrap).toHaveBeenCalledTimes(6))
    expect(deps.streamService.bootstrap.mock.calls[0][1]).toBe("stream_current")
    held.resolve()
    await connect
    expect({ calls: deps.streamService.bootstrap.mock.calls.length, peak }).toEqual({ calls: 20, peak: 6 })
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
    bumpAccountGeneration()
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
    socket.connected = false
    engine.onDisconnect()
    await engine.refreshAfterConnectivityResume()
    expect(deps.streamService.bootstrap).toHaveBeenCalledWith("ws_1", "stream_current", { after: "1" })
    expect((await db.events.get("evt_2"))?.payload).toMatchObject({ contentMarkdown: "HTTP recovered" })
  }, 10_000)

  it("should recover a URL-visible bare panel over HTTP without recovering background board roots", async () => {
    const { deps, engine, socket } = await setup()
    deps.streamService.bootstrap.mockResolvedValueOnce(makeStreamBootstrap("stream_panel", "1"))
    engine.setVisibleStreamIds(["stream_panel"])
    await vi.waitFor(async () => expect(await db.events.get("evt_1")).toBeTruthy())
    socket.connected = false
    engine.onDisconnect()
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
