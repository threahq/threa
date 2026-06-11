import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Socket } from "socket.io-client"
import { QueryClient } from "@tanstack/react-query"
import { SyncEngine } from "./sync-engine"
import { SyncStatusStore } from "./sync-status"
import { markInitialRevealComplete, resetRevealGate } from "./reveal-gate"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { db } from "@/db"
import {
  DEFAULT_USER_PREFERENCES,
  DEFAULT_WORKSPACE_SETTINGS,
  DEFAULT_SIDEBAR_CONFIG,
  type WorkspaceBootstrap,
  type StreamBootstrap,
} from "@threa/types"

type EventHandler = (...args: unknown[]) => void

class MockSocket {
  connected = true
  /** null = never ack; true = ack immediately with ok; false = reserved */
  ackBehavior: "immediate" | "never" | "delayed" = "immediate"
  ackDelayMs = 0
  disconnectCalls = 0
  connectCalls = 0
  emittedEvents: Array<{ event: string; args: unknown[] }> = []
  /** Runs before a join is acked — lets tests simulate live events landing
   *  while the room join is in flight. */
  joinInterceptor: ((room: string) => Promise<void>) | null = null
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
      const room = args[0] as string
      const callback = args[1] as ((result?: { ok: boolean }) => void) | undefined
      if (this.joinInterceptor) {
        // Ack on both paths so a rejecting interceptor can't hang an awaited join.
        void this.joinInterceptor(room)
          .then(() => callback?.({ ok: true }))
          .catch(() => callback?.({ ok: false }))
      } else {
        callback?.({ ok: true })
      }
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
    sidebarConfig: DEFAULT_SIDEBAR_CONFIG,
    userPreferences: {
      ...DEFAULT_USER_PREFERENCES,
      workspaceId: "ws_1",
      userId: "user_1",
      createdAt: now,
      updatedAt: now,
    },
    workspaceSettings: {
      ...DEFAULT_WORKSPACE_SETTINGS,
      workspaceId: "ws_1",
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

/**
 * Seed the full set of IDB rows the coordinated-loading gate requires to reveal
 * from cache: the workspace row plus the unread / metadata / sidebar singletons.
 * Mirrors `workspaceDataReady` in coordinated-loading-context.tsx so the engine's
 * write-deferral check sees a complete cache.
 */
async function seedRevealableWorkspace(workspaceId: string): Promise<void> {
  const now = new Date().toISOString()
  const cachedAt = Date.now()
  await Promise.all([
    db.workspaces.put({
      id: workspaceId,
      name: "Cached",
      slug: "cached",
      createdAt: now,
      updatedAt: now,
      _cachedAt: cachedAt,
    }),
    db.unreadState.put({
      id: workspaceId,
      workspaceId,
      unreadCounts: {},
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      mutedStreamIds: [],
      _cachedAt: cachedAt,
    }),
    db.workspaceMetadata.put({
      id: workspaceId,
      workspaceId,
      emojis: [],
      emojiWeights: {},
      commands: [],
      _cachedAt: cachedAt,
    }),
    db.sidebarConfigs.put({ id: workspaceId, workspaceId, config: DEFAULT_SIDEBAR_CONFIG, _cachedAt: cachedAt }),
  ])
}

describe("SyncEngine.handlePageResume", () => {
  beforeEach(async () => {
    resetRevealGate()
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
      db.sidebarConfigs.clear(),
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

  it("joins every member-stream room after a successful bootstrap", async () => {
    const deps = makeDeps()
    const bootstrap = makeWorkspaceBootstrap()
    bootstrap.streamMemberships = [
      {
        streamId: "stream_7",
        memberId: "user_1",
        notificationLevel: null,
        lastReadEventId: null,
        lastReadAt: null,
        joinedAt: new Date().toISOString(),
      },
    ]
    deps.workspaceService.bootstrap.mockResolvedValueOnce(bootstrap)
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))

    await vi.waitFor(() => {
      const joinedRooms = socket.emittedEvents.filter((event) => event.event === "join").map((event) => event.args[0])
      expect(joinedRooms).toContain("ws:ws_1:stream:stream_7")
    })
  })

  it("joins member-stream rooms from the cache when the fresh bootstrap fails", async () => {
    // Regression: a slow/failed first bootstrap must not leave the user in zero
    // stream rooms. Without the cache fallback, stream:activity (sidebar unread +
    // hover preview) only flows for streams opened this session.
    const now = new Date().toISOString()
    await db.workspaces.put({
      id: "ws_1",
      name: "Test",
      slug: "test",
      createdAt: now,
      updatedAt: now,
      _cachedAt: Date.now(),
    })
    await db.streamMemberships.put({
      id: "ws_1:stream_42",
      workspaceId: "ws_1",
      streamId: "stream_42",
      memberId: "user_1",
      notificationLevel: null,
      lastReadEventId: null,
      lastReadAt: null,
      joinedAt: now,
      _cachedAt: Date.now(),
    })

    const deps = makeDeps()
    deps.workspaceService.bootstrap.mockRejectedValueOnce(new Error("network down"))
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))

    await vi.waitFor(() => {
      const joinedRooms = socket.emittedEvents.filter((event) => event.event === "join").map((event) => event.args[0])
      expect(joinedRooms).toContain("ws:ws_1:stream:stream_42")
    })
  })

  it("fetches immediately on the first warm connect but holds the IDB write until the cached reveal paints", async () => {
    // Online-slower-than-offline regression: the network fetch must run right
    // away, but applyWorkspaceBootstrap's IndexedDB write has to wait for the
    // cached reveal so it doesn't starve the reveal's reads.
    await seedRevealableWorkspace("ws_1")

    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    socket.ackBehavior = "immediate"

    // Don't await — the write is parked behind the reveal until we signal it.
    const connectPromise = engine.onConnect(asSocket(socket))

    // The fetch fires immediately, in parallel with the (not-yet-signalled) reveal.
    await vi.waitFor(() => {
      expect(deps.workspaceService.bootstrap).toHaveBeenCalledTimes(1)
    })
    // ...but the bootstrap has not been committed to the query cache yet.
    expect(deps.queryClient.getQueryData(workspaceKeys.bootstrap("ws_1"))).toBeUndefined()

    // Cached content painted → the write is released.
    markInitialRevealComplete("ws_1")
    await connectPromise

    expect(deps.queryClient.getQueryData(workspaceKeys.bootstrap("ws_1"))).toBeDefined()
  })

  it("commits the write without waiting on a cold first connect (nothing cached to reveal)", async () => {
    // No cached workspace row: there's nothing to reveal, so the bootstrap must
    // commit without waiting — otherwise a first-ever load would stall on the
    // reveal timeout.
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    socket.ackBehavior = "immediate"

    await engine.onConnect(asSocket(socket))

    expect(deps.queryClient.getQueryData(workspaceKeys.bootstrap("ws_1"))).toBeDefined()
  })

  it("does not wait when the cache is partial (workspace row present, gating singleton missing)", async () => {
    // Deadlock guard: the gate only reveals once the workspace row AND the
    // unread/metadata/sidebar singletons are all cached. A partial cache (e.g.
    // an interrupted prior session, or a schema upgrade that added a gating
    // singleton) can only become ready once THIS write lands — so the engine
    // must NOT wait on the reveal, or it would stall until the timeout. Here
    // the sidebar config is missing, so the write commits immediately even
    // though no reveal is ever signalled.
    await seedRevealableWorkspace("ws_1")
    await db.sidebarConfigs.delete("ws_1")

    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    socket.ackBehavior = "immediate"

    // Awaiting onConnect would hang for the full reveal timeout if the write
    // were (incorrectly) gated — instead it resolves promptly.
    await engine.onConnect(asSocket(socket))

    expect(deps.queryClient.getQueryData(workspaceKeys.bootstrap("ws_1"))).toBeDefined()
  })

  it("does not write the bootstrap if the engine is torn down during the reveal wait", async () => {
    // Account/workspace switch destroys the engine and repoints the shared db
    // proxy + queryClient while bootstrapWorkspace is parked on the reveal wait.
    // The stale bootstrap must not be committed into the now-foreign account.
    await seedRevealableWorkspace("ws_1")

    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    socket.ackBehavior = "immediate"

    const connectPromise = engine.onConnect(asSocket(socket))
    await vi.waitFor(() => {
      expect(deps.workspaceService.bootstrap).toHaveBeenCalledTimes(1)
    })

    // Torn down mid-wait, then the reveal fires (e.g. the timeout, or the new
    // subtree's gate). The resumed write must bail.
    engine.destroy()
    markInitialRevealComplete("ws_1")
    await connectPromise

    expect(deps.queryClient.getQueryData(workspaceKeys.bootstrap("ws_1"))).toBeUndefined()
  })
})

describe("SyncEngine reconnect catch-up cursor (INV-53 gap safety)", () => {
  beforeEach(async () => {
    resetRevealGate()
    await Promise.all([db.workspaces.clear(), db.events.clear(), db.streams.clear(), db.streamMemberships.clear()])
  })

  async function seedEvent(streamId: string, sequence: number): Promise<void> {
    await db.events.put({
      id: `evt_${sequence}`,
      workspaceId: "ws_1",
      streamId,
      sequence: String(sequence),
      eventType: "message_created",
      payload: {
        messageId: `msg_${sequence}`,
        contentMarkdown: "old",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _sequenceNum: sequence,
      _cachedAt: Date.now(),
    })
  }

  it("reads the reconnect catch-up cursor before re-joining the stream room", async () => {
    // A live message can land the moment the room is re-joined — before the
    // catch-up fetch runs. Reading the cursor after the join lets that message
    // advance it past the disconnect gap, permanently skipping everything
    // missed while offline. The cursor must reflect the pre-join tail.
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)

    await seedEvent("stream_1", 1)
    engine.setVisibleStreamIds(["stream_1"])
    deps.streamService.bootstrap.mockClear()

    // Live event arrives through the freshly-joined room, mid-reconnect.
    socket.joinInterceptor = async (room) => {
      if (room === "ws:ws_1:stream:stream_1") {
        await seedEvent("stream_1", 3)
      }
    }

    await engine.onConnect(asSocket(socket)) // second connect → reconnect

    expect(deps.streamService.bootstrap).toHaveBeenCalledWith("ws_1", "stream_1", { after: "1" })
  })

  it("reads the navigation refresh cursor before the room join can deliver live events", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)

    deps.streamService.bootstrap.mockClear()
    deps.queryClient.setQueryData(["streams", "bootstrap", "ws_1", "stream_1"], makeStreamBootstrap("stream_1", "1"))
    await seedEvent("stream_1", 1)

    socket.joinInterceptor = async (room) => {
      if (room === "ws:ws_1:stream:stream_1") {
        await seedEvent("stream_1", 3)
      }
    }

    engine.setCurrentStreamId("stream_1")

    await vi.waitFor(() => {
      expect(deps.streamService.bootstrap).toHaveBeenCalledWith("ws_1", "stream_1", { after: "1" })
    })
  })
})

describe("SyncEngine.backfillStreamGap", () => {
  beforeEach(async () => {
    resetRevealGate()
    await Promise.all([db.workspaces.clear(), db.events.clear(), db.streams.clear(), db.streamMemberships.clear()])
  })

  it("fetches events after the provided pre-gap cursor and applies them", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)
    deps.streamService.bootstrap.mockClear()

    await engine.backfillStreamGap("stream_1", "1")

    expect(deps.streamService.bootstrap).toHaveBeenCalledWith("ws_1", "stream_1", { after: "1" })
    expect(await db.events.get("evt_2")).toBeTruthy()
  })

  it("single-flights concurrent backfills for the same stream", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)
    deps.streamService.bootstrap.mockClear()

    await Promise.all([engine.backfillStreamGap("stream_1", "1"), engine.backfillStreamGap("stream_1", "1")])

    expect(deps.streamService.bootstrap).toHaveBeenCalledTimes(1)
  })

  it("queues a distinct gap reported mid-flight and backfills it after the active one settles", async () => {
    // A second gap with a different cursor may cover events that committed
    // after the in-flight fetch's server read — dropping it would leave the
    // hole until the next reconnect. It must chain one follow-up fetch.
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    await primeConnectedEngine(engine, socket)
    deps.streamService.bootstrap.mockClear()

    let resolveFirst: (bootstrap: StreamBootstrap) => void = () => {}
    deps.streamService.bootstrap.mockImplementationOnce(
      () =>
        new Promise<StreamBootstrap>((resolve) => {
          resolveFirst = resolve
        })
    )

    const first = engine.backfillStreamGap("stream_1", "1")
    // Distinct gap arrives while the first backfill is in flight.
    void engine.backfillStreamGap("stream_1", "3")

    resolveFirst(makeStreamBootstrap("stream_1", "2"))
    await first

    await vi.waitFor(() => {
      expect(deps.streamService.bootstrap).toHaveBeenCalledTimes(2)
      expect(deps.streamService.bootstrap).toHaveBeenNthCalledWith(1, "ws_1", "stream_1", { after: "1" })
      expect(deps.streamService.bootstrap).toHaveBeenNthCalledWith(2, "ws_1", "stream_1", { after: "3" })
    })
  })

  it("backfills when a live socket event skips past the cached tail (end to end)", async () => {
    const deps = makeDeps()
    const workspaceBootstrap = makeWorkspaceBootstrap()
    workspaceBootstrap.streamMemberships = [
      {
        streamId: "stream_7",
        memberId: "user_1",
        notificationLevel: null,
        lastReadEventId: null,
        lastReadAt: null,
        joinedAt: new Date().toISOString(),
      },
    ]
    deps.workspaceService.bootstrap.mockResolvedValueOnce(workspaceBootstrap)
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    await db.events.put({
      id: "evt_1",
      workspaceId: "ws_1",
      streamId: "stream_7",
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

    await engine.onConnect(asSocket(socket))
    deps.streamService.bootstrap.mockClear()

    // Sequence 2 was missed (e.g. server bounce); 3 arrives live.
    socket.trigger("message:created", {
      workspaceId: "ws_1",
      streamId: "stream_7",
      event: {
        id: "evt_3",
        streamId: "stream_7",
        sequence: "3",
        eventType: "message_created",
        payload: {
          messageId: "msg_3",
          contentMarkdown: "new",
          contentJson: { type: "doc", content: [{ type: "paragraph" }] },
        },
        actorId: "user_2",
        actorType: "user",
        createdAt: new Date().toISOString(),
      },
    })

    await vi.waitFor(() => {
      expect(deps.streamService.bootstrap).toHaveBeenCalledWith("ws_1", "stream_7", { after: "1" })
    })
  })
})
