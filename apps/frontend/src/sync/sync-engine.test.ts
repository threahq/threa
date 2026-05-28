import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Socket } from "socket.io-client"
import { QueryClient } from "@tanstack/react-query"
import { SyncEngine } from "./sync-engine"
import { SyncStatusStore } from "./sync-status"
import { db } from "@/db"
import { DEFAULT_USER_PREFERENCES, type WorkspaceBootstrap, type StreamBootstrap } from "@threa/types"

type EventHandler = (...args: unknown[]) => void

class MockSocket {
  connected = true
  /** null = never ack; true = ack immediately with ok; false = reserved */
  ackBehavior: "immediate" | "never" | "delayed" = "immediate"
  ackDelayMs = 0
  disconnectCalls = 0
  connectCalls = 0
  emittedEvents: Array<{ event: string; args: unknown[] }> = []
  private listeners = new Map<string, Set<EventHandler>>()

  on(event: string, handler: EventHandler) {
    const handlers = this.listeners.get(event)
    if (handlers) handlers.add(handler)
    else this.listeners.set(event, new Set([handler]))
    return this
  }

  off(event: string, handler: EventHandler) {
    this.listeners.get(event)?.delete(handler)
    return this
  }

  emit(event: string, ...args: unknown[]) {
    this.emittedEvents.push({ event, args })

    if (event === "health:ping") {
      const callback = args[0] as (() => void) | undefined
      if (!callback) return this
      if (this.ackBehavior === "never") return this
      if (this.ackBehavior === "immediate") {
        callback()
      } else {
        setTimeout(callback, this.ackDelayMs)
      }
      return this
    }

    // join ack: reply ok so onConnect's workspace join succeeds in tests
    if (event === "join") {
      const callback = args[1] as ((result?: { ok: boolean }) => void) | undefined
      callback?.({ ok: true })
      return this
    }

    return this
  }

  trigger(event: string, ...args: unknown[]) {
    const handlers = this.listeners.get(event)
    if (!handlers) return
    for (const handler of handlers) handler(...args)
  }

  disconnect() {
    this.disconnectCalls += 1
    this.connected = false
    return this
  }

  connect() {
    this.connectCalls += 1
    return this
  }
}

function asSocket(mock: MockSocket): Socket {
  return mock as unknown as Socket
}

function makeWorkspaceBootstrap(): WorkspaceBootstrap {
  const now = new Date().toISOString()
  return {
    workspace: {
      id: "ws_1",
      name: "Test",
      slug: "test",
      createdBy: "user_1",
      createdAt: now,
      updatedAt: now,
    },
    users: [],
    streams: [],
    streamMemberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
    emojis: [],
    emojiWeights: {},
    commands: [],
    unreadCounts: {},
    mentionCounts: {},
    activityCounts: {},
    unreadActivityCount: 0,
    mutedStreamIds: [],
    labels: [],
    labelMemberships: [],
    labelAssignments: [],
    viewerPermissions: [],
    userPreferences: {
      ...DEFAULT_USER_PREFERENCES,
      workspaceId: "ws_1",
      userId: "user_1",
      createdAt: now,
      updatedAt: now,
    },
  } satisfies WorkspaceBootstrap
}

function makeStreamBootstrap(streamId = "stream_1", sequence = "2"): StreamBootstrap {
  const now = new Date().toISOString()
  return {
    stream: {
      id: streamId,
      workspaceId: "ws_1",
      type: "dm",
      displayName: null,
      slug: null,
      description: null,
      visibility: "private",
      parentStreamId: null,
      parentMessageId: null,
      rootStreamId: null,
      companionMode: "off",
      companionPersonaId: null,
      createdBy: "user_1",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    },
    events: [
      {
        id: `evt_${sequence}`,
        streamId,
        sequence,
        eventType: "message_created",
        payload: {
          messageId: `msg_${sequence}`,
          contentMarkdown: "new",
          contentJson: { type: "doc", content: [{ type: "paragraph" }] },
        },
        actorId: "user_1",
        actorType: "user",
        createdAt: now,
      },
    ],
    members: [],
    botMemberIds: [],
    membership: {
      streamId,
      memberId: "user_1",
      pinned: false,
      pinnedAt: null,
      notificationLevel: null,
      lastReadEventId: null,
      lastReadAt: null,
      joinedAt: now,
    },
    latestSequence: sequence,
    hasOlderEvents: false,
    syncMode: "append",
    unreadCount: 0,
    mentionCount: 0,
    activityCount: 0,
    sharedMessages: {},
    contextBag: { bag: null, refs: [] },
  } satisfies StreamBootstrap
}

function makeDeps() {
  const workspaceBootstrap = vi.fn(async () => makeWorkspaceBootstrap())
  const streamBootstrap = vi.fn(async (_workspaceId: string, streamId: string) => makeStreamBootstrap(streamId))
  return {
    workspaceId: "ws_1",
    syncStatus: new SyncStatusStore(),
    queryClient: new QueryClient(),
    workspaceService: { bootstrap: workspaceBootstrap },
    streamService: { bootstrap: streamBootstrap },
  }
}

async function primeConnectedEngine(engine: SyncEngine, socket: MockSocket): Promise<void> {
  await engine.onConnect(asSocket(socket))
}

describe("SyncEngine.handlePageResume", () => {
  beforeEach(async () => {
    await Promise.all([
      db.workspaces.clear(),
      db.workspaceUsers.clear(),
      db.streams.clear(),
      db.streamMemberships.clear(),
      db.dmPeers.clear(),
      db.personas.clear(),
      db.bots.clear(),
      db.unreadState.clear(),
      db.userPreferences.clear(),
      db.workspaceMetadata.clear(),
      db.events.clear(),
      db.pendingMessages.clear(),
    ])
  })

  it("is a no-op when the engine has never connected", async () => {
    const engine = new SyncEngine(makeDeps())
    const refreshSpy = vi.spyOn(engine, "refreshAfterConnectivityResume")

    await engine.handlePageResume()

    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it("soft refreshes visible data even before the first socket connect", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)

    await engine.refreshAfterConnectivityResume()

    expect(deps.workspaceService.bootstrap).toHaveBeenCalledTimes(1)
  })

  it("is a no-op when the engine is destroyed", async () => {
    const engine = new SyncEngine(makeDeps())
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)
    engine.destroy()

    const refreshSpy = vi.spyOn(engine, "refreshAfterConnectivityResume")
    await engine.handlePageResume()

    expect(refreshSpy).not.toHaveBeenCalled()
    expect(socket.disconnectCalls).toBe(0)
    expect(socket.connectCalls).toBe(0)
  })

  it("is a no-op when the transport is already disconnected", async () => {
    const engine = new SyncEngine(makeDeps())
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)
    socket.connected = false

    const refreshSpy = vi.spyOn(engine, "refreshAfterConnectivityResume")
    const pingsBefore = socket.emittedEvents.filter((e) => e.event === "health:ping").length

    await engine.handlePageResume()

    expect(refreshSpy).not.toHaveBeenCalled()
    expect(socket.disconnectCalls).toBe(0)
    expect(socket.connectCalls).toBe(0)
    expect(socket.emittedEvents.filter((e) => e.event === "health:ping").length).toBe(pingsBefore)
  })

  it("refreshes after a successful ping", async () => {
    const engine = new SyncEngine(makeDeps())
    const socket = new MockSocket()
    socket.ackBehavior = "immediate"
    await primeConnectedEngine(engine, socket)

    const refreshSpy = vi.spyOn(engine, "refreshAfterConnectivityResume").mockResolvedValue()

    await engine.handlePageResume()

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(socket.disconnectCalls).toBe(0)
    expect(socket.connectCalls).toBe(0)
  })

  it("force-reconnects after a failed ping and skips refresh", async () => {
    const engine = new SyncEngine(makeDeps())
    const socket = new MockSocket()
    socket.ackBehavior = "never"
    await primeConnectedEngine(engine, socket)

    const refreshSpy = vi.spyOn(engine, "refreshAfterConnectivityResume").mockResolvedValue()

    // Use a short timeout inside pingSocket via module constant default (3000) — but
    // the test uses real timers and we don't want to wait 3s. Trigger a disconnect
    // event instead so pingSocket settles immediately with `false`.
    const resumePromise = engine.handlePageResume()
    // Let the ping emit happen in the microtask queue
    await Promise.resolve()
    socket.trigger("disconnect", "transport close")

    await resumePromise

    expect(refreshSpy).not.toHaveBeenCalled()
    expect(socket.disconnectCalls).toBe(1)
    expect(socket.connectCalls).toBe(1)
  })

  it("does not double-bootstrap on rapid successive resume calls", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    socket.ackBehavior = "immediate"
    await primeConnectedEngine(engine, socket)

    // Clear the bootstrap count from onConnect
    deps.workspaceService.bootstrap.mockClear()

    await Promise.all([engine.handlePageResume(), engine.handlePageResume()])

    // activeBootstrap singleflight + queuedReconnectBootstrap guarantees
    // at most 2 bootstrap fetches for overlapping calls (active + 1 queued).
    // Two rapid resume calls should NOT fan out to 3+ fetches.
    expect(deps.workspaceService.bootstrap.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it("does not refresh a route stream while the socket transport is disconnected", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)

    deps.streamService.bootstrap.mockClear()
    socket.connected = false
    engine.onDisconnect()

    engine.setCurrentStreamId("stream_1")
    await Promise.resolve()

    expect(deps.streamService.bootstrap).not.toHaveBeenCalled()
    expect(socket.emittedEvents.filter((event) => event.event === "join")).toHaveLength(1)
  })

  it("refreshes the current stream when navigating to it in an already-connected app", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)

    deps.streamService.bootstrap.mockClear()
    deps.queryClient.setQueryData(["streams", "bootstrap", "ws_1", "stream_1"], makeStreamBootstrap("stream_1", "1"))
    await db.events.put({
      id: "evt_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      sequence: "1",
      eventType: "message_created",
      payload: {
        messageId: "msg_1",
        contentMarkdown: "old",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _sequenceNum: 1,
      _cachedAt: Date.now(),
    })

    engine.setCurrentStreamId("stream_1")
    await vi.waitFor(() => {
      expect(deps.streamService.bootstrap).toHaveBeenCalledWith("ws_1", "stream_1", { after: "1" })
      expect(deps.queryClient.getQueryData(["streams", "bootstrap", "ws_1", "stream_1"])).toMatchObject({
        latestSequence: "2",
      })
    })

    expect(await db.events.get("evt_2")).toBeTruthy()
  })

  it("merges navigation refresh results against concurrent query cache updates", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)

    let resolveBootstrap: (bootstrap: StreamBootstrap) => void = () => {}
    const bootstrapPromise = new Promise<StreamBootstrap>((resolve) => {
      resolveBootstrap = resolve
    })

    deps.streamService.bootstrap.mockClear()
    deps.streamService.bootstrap.mockImplementationOnce(() => bootstrapPromise)
    deps.queryClient.setQueryData(["streams", "bootstrap", "ws_1", "stream_1"], makeStreamBootstrap("stream_1", "1"))
    await db.events.put({
      id: "evt_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      sequence: "1",
      eventType: "message_created",
      payload: {
        messageId: "msg_1",
        contentMarkdown: "old",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _sequenceNum: 1,
      _cachedAt: Date.now(),
    })

    engine.setCurrentStreamId("stream_1")
    await vi.waitFor(() => {
      expect(deps.streamService.bootstrap).toHaveBeenCalledWith("ws_1", "stream_1", { after: "1" })
    })

    const concurrentBootstrap = makeStreamBootstrap("stream_1", "3")
    deps.queryClient.setQueryData(["streams", "bootstrap", "ws_1", "stream_1"], concurrentBootstrap)

    resolveBootstrap(makeStreamBootstrap("stream_1", "2"))
    await vi.waitFor(() => {
      const cached = deps.queryClient.getQueryData<StreamBootstrap>(["streams", "bootstrap", "ws_1", "stream_1"])
      expect(cached?.latestSequence).toBe("3")
      expect(cached?.events.map((event) => event.id)).toEqual(["evt_2", "evt_3"])
    })
  })

  it("uses a full bootstrap on navigation when only IndexedDB has stream data", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)

    deps.streamService.bootstrap.mockClear()
    await db.events.put({
      id: "evt_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      sequence: "1",
      eventType: "message_created",
      payload: {
        messageId: "msg_1",
        contentMarkdown: "old",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _sequenceNum: 1,
      _cachedAt: Date.now(),
    })

    engine.setCurrentStreamId("stream_1")
    await vi.waitFor(() => {
      expect(deps.streamService.bootstrap).toHaveBeenCalledWith("ws_1", "stream_1", undefined)
    })
  })
})
