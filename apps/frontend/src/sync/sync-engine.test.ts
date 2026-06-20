import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { Socket } from "socket.io-client"
import { QueryClient } from "@tanstack/react-query"
import { SyncEngine, isSyncEngineCurrent } from "./sync-engine"
import { SyncStatusStore } from "./sync-status"
import { markInitialRevealComplete, resetRevealGate } from "./reveal-gate"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { db } from "@/db"
import {
  DEFAULT_USER_PREFERENCES,
  DEFAULT_WORKSPACE_SETTINGS,
  defaultFeatureFlags,
  DEFAULT_SIDEBAR_CONFIG,
  type WorkspaceBootstrap,
  type StreamBootstrap,
  type SyncCatchUpResponse,
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
  private anyListeners = new Set<(event: string, ...args: unknown[]) => void>()

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

  onAny(listener: (event: string, ...args: unknown[]) => void) {
    this.anyListeners.add(listener)
    return this
  }

  offAny(listener?: (event: string, ...args: unknown[]) => void) {
    if (listener) this.anyListeners.delete(listener)
    else this.anyListeners.clear()
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
    for (const listener of this.anyListeners) listener(event, ...args)
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
    featureFlags: defaultFeatureFlags(),
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

describe("SyncEngine sync cursor (active mode)", () => {
  beforeEach(async () => {
    resetRevealGate()
    await Promise.all([
      db.workspaces.clear(),
      db.syncCursors.clear(),
      db.workspaceUsers.clear(),
      db.unreadState.clear(),
      db.streams.clear(),
    ])
  })

  function makeActiveDeps(catchUp: ReturnType<typeof vi.fn>) {
    return {
      ...makeDeps(),
      syncService: { catchUp: catchUp as (...args: unknown[]) => Promise<SyncCatchUpResponse> },
    }
  }

  function emptyPage(head: string): SyncCatchUpResponse {
    return { entries: [], head }
  }

  function userAddedEntry(syncId: string, userId: string): SyncCatchUpResponse["entries"][number] {
    return {
      syncId,
      eventType: "workspace_user:added",
      payload: { workspaceId: "ws_1", user: { id: userId, workspaceId: "ws_1", name: `User ${userId}` } },
      createdAt: new Date().toISOString(),
    }
  }

  function userAddedLivePayload(syncId: string, userId: string) {
    return {
      workspaceId: "ws_1",
      syncId,
      user: { id: userId, workspaceId: "ws_1", name: `User ${userId}` },
    }
  }

  it("seeds the cursor from head BEFORE the workspace bootstrap data fetch on first run", async () => {
    const order: string[] = []
    const catchUp = vi.fn(async () => {
      order.push("catchUp")
      return emptyPage("42")
    })
    const deps = makeActiveDeps(catchUp)
    const innerBootstrap = deps.workspaceService.bootstrap
    deps.workspaceService.bootstrap = vi.fn(async () => {
      order.push("bootstrap")
      return innerBootstrap()
    })
    const engine = new SyncEngine(deps)

    await engine.onConnect(asSocket(new MockSocket()))

    expect(order[0]).toBe("catchUp")
    expect(order).toContain("bootstrap")
    expect(catchUp).toHaveBeenNthCalledWith(1, "ws_1", { after: "0", limit: 1 }, expect.any(AbortSignal))
    await vi.waitFor(() => expect(engine.getSyncCursor()).toBe("42"))
    engine.destroy()
  })

  it("applies catch-up entries through the registered live handlers and advances the cursor by applied entries", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const catchUp = vi
      .fn()
      .mockResolvedValueOnce({ entries: [userAddedEntry("11", "user_a"), userAddedEntry("12", "user_b")], head: "12" })
      .mockResolvedValue(emptyPage("12"))
    const engine = new SyncEngine(makeActiveDeps(catchUp))

    await engine.onConnect(asSocket(new MockSocket()))

    await vi.waitFor(async () => {
      expect(await db.workspaceUsers.get("user_a")).toBeDefined()
      expect(await db.workspaceUsers.get("user_b")).toBeDefined()
    })
    expect(engine.getSyncCursor()).toBe("12")
    engine.destroy()
  })

  it("re-bootstraps and jumps the cursor to head when catch-up reports the cursor is below the retention floor", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    // The cursor (10) predates the pruned span, so the log can't heal the gap:
    // catch-up returns requiresBootstrap with no entries instead of a partial
    // page. The connect bootstrap runs first; the fallback fires a second.
    const catchUp = vi.fn().mockResolvedValue({ entries: [], head: "500", requiresBootstrap: true })
    const deps = makeActiveDeps(catchUp)
    const engine = new SyncEngine(deps)

    await engine.onConnect(asSocket(new MockSocket()))

    // The cursor jumps to head — the snapshot is the authority for <= head —
    // and the below-floor catch-up triggered a fresh bootstrap on top of the
    // connect one (so nothing from the pruned span is silently skipped).
    await vi.waitFor(() => expect(engine.getSyncCursor()).toBe("500"))
    await vi.waitFor(() => expect(deps.workspaceService.bootstrap.mock.calls.length).toBeGreaterThanOrEqual(2))
    engine.destroy()
  })

  it("buffers live events while catch-up runs and splices those above the catch-up position afterwards", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    let resolveFirstPage: ((value: SyncCatchUpResponse) => void) | undefined
    const catchUp = vi
      .fn()
      .mockImplementationOnce(() => new Promise<SyncCatchUpResponse>((resolve) => (resolveFirstPage = resolve)))
      .mockResolvedValue(emptyPage("11"))
    const engine = new SyncEngine(makeActiveDeps(catchUp))
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(resolveFirstPage).toBeDefined())

    // Lands while catch-up pages: buffered, not applied.
    socket.trigger("workspace_user:added", userAddedLivePayload("12", "user_live"))
    expect(await db.workspaceUsers.get("user_live")).toBeUndefined()

    resolveFirstPage!({ entries: [userAddedEntry("11", "user_log")], head: "11" })

    await vi.waitFor(async () => {
      expect(await db.workspaceUsers.get("user_log")).toBeDefined()
      expect(await db.workspaceUsers.get("user_live")).toBeDefined()
    })
    expect(engine.getSyncCursor()).toBe("12")
    engine.destroy()
  })

  /** Active deps whose bootstrap carries counter baselines for stream_x:
   *  5 messages, 1 unread (implied read position 4), 1 activity, plus a
   *  membership so the live handlers' IDB writes pass the member check. */
  function makeCounterDeps(catchUp: ReturnType<typeof vi.fn>) {
    const deps = makeActiveDeps(catchUp)
    deps.workspaceService.bootstrap = vi.fn(async () => ({
      ...makeWorkspaceBootstrap(),
      streamMemberships: [
        {
          streamId: "stream_x",
          memberId: "member_1",
          notificationLevel: null,
          lastReadEventId: null,
          lastReadAt: null,
          joinedAt: new Date().toISOString(),
        },
      ],
      unreadCounts: { stream_x: 1 },
      mentionCounts: { stream_x: 0 },
      activityCounts: { stream_x: 1 },
      unreadActivityCount: 1,
      messageCounts: { stream_x: 5 },
    }))
    return deps
  }

  function streamActivityEntry(
    syncId: string,
    messageOrdinal: number,
    content = "hi"
  ): SyncCatchUpResponse["entries"][number] {
    return {
      syncId,
      eventType: "stream:activity",
      payload: {
        workspaceId: "ws_1",
        streamId: "stream_x",
        authorId: "member_other",
        sequence: String(messageOrdinal),
        messageOrdinal,
        lastMessagePreview: {
          authorId: "member_other",
          authorType: "user",
          content,
          createdAt: new Date().toISOString(),
        },
      },
      createdAt: new Date().toISOString(),
    }
  }

  function activityCountsEntry(
    syncId: string,
    counts: { mentionCount: number; activityCount: number }
  ): SyncCatchUpResponse["entries"][number] {
    return {
      syncId,
      eventType: "activity:created",
      payload: {
        workspaceId: "ws_1",
        targetUserId: "member_1",
        counts,
        activity: { id: `act_${syncId}`, streamId: "stream_x", activityType: "mention", isSelf: false },
      },
      createdAt: new Date().toISOString(),
    }
  }

  it("applies absolute counter entries from the log without double-counting the bootstrap snapshot", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const catchUp = vi
      .fn()
      // Entry 11 (ordinal 5) is already reflected in the snapshot — the safe
      // duplicate side of read-before-stamp; entry 12 (ordinal 6) is new.
      .mockResolvedValueOnce({ entries: [streamActivityEntry("11", 5), streamActivityEntry("12", 6)], head: "12" })
      .mockResolvedValue(emptyPage("12"))
    const engine = new SyncEngine(makeCounterDeps(catchUp))

    await engine.onConnect(asSocket(new MockSocket()))

    await vi.waitFor(async () => {
      const unread = await db.unreadState.get("ws_1")
      expect(unread?.unreadCounts["stream_x"]).toBe(2)
      expect(unread?.latestOrdinals?.["stream_x"]).toBe(6)
    })
    expect(engine.getSyncCursor()).toBe("12")
    engine.destroy()
  })

  it("replays a read-zero between two absolute activity entries in log order", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const catchUp = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [
          activityCountsEntry("11", { mentionCount: 2, activityCount: 2 }),
          {
            syncId: "12",
            eventType: "stream:read",
            payload: {
              workspaceId: "ws_1",
              authorId: "member_1",
              streamId: "stream_x",
              lastReadEventId: "evt_5",
              lastReadSequence: "5",
              lastReadOrdinal: 5,
            },
            createdAt: new Date().toISOString(),
          },
          activityCountsEntry("13", { mentionCount: 0, activityCount: 1 }),
        ],
        head: "13",
      })
      .mockResolvedValue(emptyPage("13"))
    const engine = new SyncEngine(makeCounterDeps(catchUp))

    await engine.onConnect(asSocket(new MockSocket()))

    await vi.waitFor(async () => {
      const unread = await db.unreadState.get("ws_1")
      // Log order: counts set to 2, read zeroes them, counts set to 1.
      expect(unread?.activityCounts["stream_x"]).toBe(1)
      expect(unread?.mentionCounts["stream_x"]).toBe(0)
      expect(unread?.unreadActivityCount).toBe(1)
      // The read position covers all 5 snapshot messages.
      expect(unread?.unreadCounts["stream_x"]).toBe(0)
    })
    expect(engine.getSyncCursor()).toBe("13")
    engine.destroy()
  })

  function streamReadEntry(syncId: string, lastReadOrdinal: number): SyncCatchUpResponse["entries"][number] {
    return {
      syncId,
      eventType: "stream:read",
      payload: {
        workspaceId: "ws_1",
        authorId: "member_1",
        streamId: "stream_x",
        lastReadEventId: `evt_${lastReadOrdinal}`,
        lastReadSequence: String(lastReadOrdinal),
        lastReadOrdinal,
      },
      createdAt: new Date().toISOString(),
    }
  }

  it("commits catch-up counters atomically — the badge never paints the intermediate bounce", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    // A run of activity→read→activity→read→activity that, applied per entry,
    // bounces the stream's activity count 1, 0, 1, 0, 2. The user must only ever
    // see the final 2; the zeroes and the early 1 are replay noise.
    const catchUp = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [
          activityCountsEntry("11", { mentionCount: 0, activityCount: 1 }),
          streamReadEntry("12", 5),
          activityCountsEntry("13", { mentionCount: 0, activityCount: 1 }),
          streamReadEntry("14", 5),
          activityCountsEntry("15", { mentionCount: 0, activityCount: 2 }),
        ],
        head: "15",
      })
      .mockResolvedValue(emptyPage("15"))
    const engine = new SyncEngine(makeCounterDeps(catchUp))
    const putSpy = vi.spyOn(db.unreadState, "put")

    await engine.onConnect(asSocket(new MockSocket()))

    await vi.waitFor(async () => {
      expect((await db.unreadState.get("ws_1"))?.activityCounts["stream_x"]).toBe(2)
    })

    // Every value the IDB-backed badge could have observed. The read entries
    // would zero the count mid-replay; an atomic commit never persists that 0.
    const observed = putSpy.mock.calls
      .map((call) => (call[0] as { activityCounts?: Record<string, number> }).activityCounts?.["stream_x"])
      .filter((value): value is number => value !== undefined)
    expect(observed).toContain(2)
    expect(observed).not.toContain(0)

    putSpy.mockRestore()
    engine.destroy()
  })

  it("coalesces catch-up stream previews — the sidebar sees only the final message, not each replayed one", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const catchUp = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [
          streamActivityEntry("11", 6, "first"),
          streamActivityEntry("12", 7, "second"),
          streamActivityEntry("13", 8, "third"),
        ],
        head: "13",
      })
      .mockResolvedValue(emptyPage("13"))
    const deps = makeCounterDeps(catchUp)
    // stream_x must be in the bootstrap so it survives applyWorkspaceBootstrap's
    // stale-entity cleanup; the catch-up replay then advances its preview.
    const baseBootstrap = await deps.workspaceService.bootstrap()
    deps.workspaceService.bootstrap = vi.fn(async () => ({
      ...baseBootstrap,
      streams: [
        {
          id: "stream_x",
          workspaceId: "ws_1",
          type: "scratchpad",
          visibility: "private",
          displayName: "X",
          slug: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastMessagePreview: {
            authorId: "member_other",
            authorType: "user",
            content: "seed",
            createdAt: "2026-01-01T00:00:00Z",
          },
        } as unknown as (typeof baseBootstrap.streams)[number],
      ],
    }))
    const engine = new SyncEngine(deps)
    const updateSpy = vi.spyOn(db.streams, "update")

    await engine.onConnect(asSocket(new MockSocket()))

    await vi.waitFor(async () => {
      expect((await db.streams.get("stream_x"))?.lastMessagePreview?.content).toBe("third")
    })

    // The replay folds three previews but persists only the last — the sidebar
    // re-sorts once on "third" instead of stepping through first/second.
    const persisted = updateSpy.mock.calls
      .filter((call) => call[0] === "stream_x")
      .map((call) => (call[1] as { lastMessagePreview?: { content?: string } }).lastMessagePreview?.content)
    expect(persisted).toContain("third")
    expect(persisted).not.toContain("first")
    expect(persisted).not.toContain("second")

    updateSpy.mockRestore()
    engine.destroy()
  })

  it("resumes the gate (drains the buffer) even when the batch flush throws", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    let resolveFirstPage: ((value: SyncCatchUpResponse) => void) | undefined
    const catchUp = vi
      .fn()
      .mockImplementationOnce(() => new Promise<SyncCatchUpResponse>((resolve) => (resolveFirstPage = resolve)))
      .mockResolvedValue(emptyPage("11"))
    const deps = makeCounterDeps(catchUp)
    // The forceFull reseed re-fetches the authoritative server snapshot. By the
    // time it runs, the buffered user (added at syncId 12) already exists
    // server-side, so the real snapshot carries it and its stale-entity cleanup
    // keeps the row the buffer drain wrote. Model that here: an empty pre-add
    // snapshot would instead let cleanup race the drain and delete user_resumed.
    const snapshotBootstrap = deps.workspaceService.bootstrap
    let bootstrapCalls = 0
    deps.workspaceService.bootstrap = vi.fn(async () => {
      const snapshot = await snapshotBootstrap()
      bootstrapCalls += 1
      if (bootstrapCalls === 1) return snapshot
      return {
        ...snapshot,
        users: [
          ...snapshot.users,
          userAddedLivePayload("12", "user_resumed").user as WorkspaceBootstrap["users"][number],
        ],
      }
    })
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()
    // Force the flush's preview write to reject → the whole flush rejects.
    const updateSpy = vi.spyOn(db.streams, "update").mockRejectedValue(new Error("idb boom"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(resolveFirstPage).toBeDefined())

    // A live event buffered during the pause must still be drained once catch-up
    // resumes the gate — even though the flush below throws.
    socket.trigger("workspace_user:added", userAddedLivePayload("12", "user_resumed"))

    // The replayed stream:activity folds a preview; flush's db.streams.update rejects.
    resolveFirstPage!({ entries: [streamActivityEntry("11", 6)], head: "11" })

    // The flush failure forces a full snapshot reseed (bootstrap called a 2nd time)
    // so the dropped counter state can't sit stale across slim reconnects.
    await vi.waitFor(() => {
      expect(deps.workspaceService.bootstrap).toHaveBeenCalledTimes(2)
    })

    await vi.waitFor(async () => {
      expect(await db.workspaceUsers.get("user_resumed")).toBeDefined()
    })
    expect(errorSpy).toHaveBeenCalledWith(
      "Sync catch-up batch flush failed",
      expect.objectContaining({ workspaceId: "ws_1" })
    )

    updateSpy.mockRestore()
    errorSpy.mockRestore()
    engine.destroy()
  })

  it("does not re-apply a buffered ABSOLUTE counter duplicate at or below the catch-up position", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    let resolveFirstPage: ((value: SyncCatchUpResponse) => void) | undefined
    const catchUp = vi
      .fn()
      .mockImplementationOnce(() => new Promise<SyncCatchUpResponse>((resolve) => (resolveFirstPage = resolve)))
      .mockResolvedValue(emptyPage("12"))
    const engine = new SyncEngine(makeCounterDeps(catchUp))
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(resolveFirstPage).toBeDefined())

    // Live duplicate of log entry 11 lands during the pause window. Its log
    // copy applies below; re-applying the buffered copy AFTER entry 12 would
    // regress the LWW activity counts back to 2.
    const duplicate = activityCountsEntry("11", { mentionCount: 0, activityCount: 2 })
    socket.trigger("activity:created", { ...(duplicate.payload as object), syncId: "11" })

    resolveFirstPage!({
      entries: [duplicate, activityCountsEntry("12", { mentionCount: 0, activityCount: 1 })],
      head: "12",
    })

    await vi.waitFor(async () => {
      expect((await db.unreadState.get("ws_1"))?.activityCounts["stream_x"]).toBe(1)
    })
    expect(engine.getSyncCursor()).toBe("12")
    // Give any stray (incorrect) splice apply a chance to land before re-checking.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await db.unreadState.get("ws_1"))?.activityCounts["stream_x"]).toBe(1)
    engine.destroy()
  })

  it("does not let a stale catch-up run reopen live flow for a newer reconnect cycle", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    let resolveFirstPage: ((value: SyncCatchUpResponse) => void) | undefined
    const catchUp = vi
      .fn()
      .mockImplementationOnce(() => new Promise<SyncCatchUpResponse>((resolve) => (resolveFirstPage = resolve)))
      .mockResolvedValue(emptyPage("11"))
    const engine = new SyncEngine(makeActiveDeps(catchUp))
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(resolveFirstPage).toBeDefined())

    // Reconnect while the first cycle's catch-up is still paging: a new
    // cycle pauses the gate and must own the eventual splice.
    await engine.onConnect(asSocket(socket))
    socket.trigger("workspace_user:added", userAddedLivePayload("20", "user_live"))

    // The stale run completes — it applies its log entry but must NOT
    // resume the gate (the buffered live event stays unapplied until the
    // new cycle's chained run splices it).
    resolveFirstPage!({ entries: [userAddedEntry("11", "user_log")], head: "11" })

    await vi.waitFor(async () => {
      expect(await db.workspaceUsers.get("user_log")).toBeDefined()
      expect(await db.workspaceUsers.get("user_live")).toBeDefined()
    })
    expect(engine.getSyncCursor()).toBe("20")
    // The new cycle ran its own catch-up from the stale run's end position
    // (one such fetch belongs to the stale run's paging, one to the rerun).
    const fetchesFromEleven = catchUp.mock.calls.filter((call) => (call[1] as { after: string }).after === "11")
    expect(fetchesFromEleven.length).toBeGreaterThanOrEqual(2)
    engine.destroy()
  })

  it("applies all buffered events when the cursor seed only succeeds after bootstrap", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      let resolveRetrySeed: ((value: SyncCatchUpResponse) => void) | undefined
      const catchUp = vi
        .fn()
        // Pre-bootstrap seed fails (offline first run)...
        .mockRejectedValueOnce(new Error("offline"))
        // ...the catch-up run's fallback retry succeeds with a head read
        // AFTER the bootstrap snapshot.
        .mockImplementationOnce(() => new Promise<SyncCatchUpResponse>((resolve) => (resolveRetrySeed = resolve)))
        .mockResolvedValue(emptyPage("42"))
      const engine = new SyncEngine(makeActiveDeps(catchUp))
      const socket = new MockSocket()

      await engine.onConnect(asSocket(socket))
      await vi.waitFor(() => expect(resolveRetrySeed).toBeDefined())

      // Buffered during the window the snapshot does not provably cover —
      // its syncId is below the late-read head, and it must still apply.
      socket.trigger("workspace_user:added", userAddedLivePayload("5", "user_live"))
      resolveRetrySeed!(emptyPage("42"))

      await vi.waitFor(async () => {
        expect(await db.workspaceUsers.get("user_live")).toBeDefined()
      })
      expect(engine.getSyncCursor()).toBe("42")
      engine.destroy()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("never applies buffered events after destroy (account-switch safety)", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const catchUp = vi.fn(() => new Promise<SyncCatchUpResponse>(() => {}))
    const engine = new SyncEngine(makeActiveDeps(catchUp))
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    socket.trigger("workspace_user:added", userAddedLivePayload("12", "user_live"))

    engine.destroy()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(await db.workspaceUsers.get("user_live")).toBeUndefined()
  })
})

describe("SyncEngine cursor gate wiring", () => {
  function makeSyncDeps() {
    const catchUp = vi.fn(async (): Promise<SyncCatchUpResponse> => ({ entries: [], head: "0" }))
    return { ...makeDeps(), syncService: { catchUp } }
  }

  it("owns an event gate when a sync service is wired, and none without one", () => {
    const withSyncService = new SyncEngine(makeSyncDeps())
    expect(withSyncService.getLiveEventSource()).not.toBeNull()
    withSyncService.destroy()

    const withoutSyncService = new SyncEngine(makeDeps())
    expect(withoutSyncService.getLiveEventSource()).toBeNull()
    withoutSyncService.destroy()
  })

  it("isSyncEngineCurrent forces recreation on workspace change and destroy only", () => {
    const engine = new SyncEngine(makeSyncDeps())

    expect(isSyncEngineCurrent(engine, "ws_other")).toBe(false)
    expect(isSyncEngineCurrent(engine, "ws_1")).toBe(true)

    engine.destroy()
    expect(isSyncEngineCurrent(engine, "ws_1")).toBe(false)
  })
})

describe("SyncEngine sync:heartbeat (active mode)", () => {
  beforeEach(async () => {
    resetRevealGate()
    await Promise.all([
      db.workspaces.clear(),
      db.syncCursors.clear(),
      db.workspaceUsers.clear(),
      db.unreadState.clear(),
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeActiveDeps(catchUp: ReturnType<typeof vi.fn>) {
    return {
      ...makeDeps(),
      syncService: { catchUp: catchUp as (...args: unknown[]) => Promise<SyncCatchUpResponse> },
    }
  }

  function emptyPage(head: string): SyncCatchUpResponse {
    return { entries: [], head }
  }

  function userAddedEntry(syncId: string, userId: string): SyncCatchUpResponse["entries"][number] {
    return {
      syncId,
      eventType: "workspace_user:added",
      payload: { workspaceId: "ws_1", user: { id: userId, workspaceId: "ws_1", name: `User ${userId}` } },
      createdAt: new Date().toISOString(),
    }
  }

  function heartbeat(head: string) {
    return { workspaceId: "ws_1", head }
  }

  /** Connect with a persisted cursor at 10 and let the connect catch-up
   *  settle (one page), so heartbeat-triggered calls are distinguishable. */
  async function connectSettledEngine(catchUp: ReturnType<typeof vi.fn>) {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const engine = new SyncEngine(makeActiveDeps(catchUp))
    const socket = new MockSocket()
    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(catchUp).toHaveBeenCalled())
    // Drain the connect catch-up's remaining microtasks (gate resume).
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { engine, socket }
  }

  it("ignores a head already covered by max(cursor, lastSeenHead) — including invisible-entry inflation", async () => {
    // Connect catch-up reports head 12 with nothing visible: the cursor stays
    // at 10 but lastSeenHead records 12 as known-clean.
    const catchUp = vi.fn().mockResolvedValue(emptyPage("12"))
    const { engine, socket } = await connectSettledEngine(catchUp)
    const baseline = catchUp.mock.calls.length

    vi.useFakeTimers()
    socket.trigger("sync:heartbeat", heartbeat("12"))
    socket.trigger("sync:heartbeat", heartbeat("11"))
    vi.advanceTimersByTime(10_000)
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(catchUp.mock.calls.length).toBe(baseline)
    engine.destroy()
  })

  it("triggers catch-up after the grace window when the head stays ahead, applying entries through the gate", async () => {
    const catchUp = vi
      .fn()
      .mockResolvedValueOnce(emptyPage("10"))
      .mockResolvedValueOnce({
        entries: [userAddedEntry("11", "user_a"), userAddedEntry("12", "user_b")],
        head: "12",
      })
      .mockResolvedValue(emptyPage("12"))
    const { engine, socket } = await connectSettledEngine(catchUp)

    vi.useFakeTimers()
    socket.trigger("sync:heartbeat", heartbeat("12"))
    // Within grace: nothing fetched yet.
    expect(catchUp.mock.calls.length).toBe(1)
    vi.advanceTimersByTime(3_500)
    vi.useRealTimers()

    await vi.waitFor(async () => {
      expect(await db.workspaceUsers.get("user_a")).toBeDefined()
      expect(await db.workspaceUsers.get("user_b")).toBeDefined()
    })
    expect(engine.getSyncCursor()).toBe("12")
    engine.destroy()
  })

  it("does not fetch when live events close the gap during the grace window", async () => {
    const catchUp = vi.fn().mockResolvedValue(emptyPage("10"))
    const { engine, socket } = await connectSettledEngine(catchUp)
    const baseline = catchUp.mock.calls.length

    vi.useFakeTimers()
    socket.trigger("sync:heartbeat", heartbeat("11"))
    // The "missing" event arrives mid-grace; the gate applies it live and the
    // cursor advances past the heartbeat head before the re-check fires.
    socket.trigger("workspace_user:added", {
      workspaceId: "ws_1",
      syncId: "11",
      user: { id: "user_live", workspaceId: "ws_1", name: "User live" },
    })
    vi.advanceTimersByTime(10_000)
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(catchUp.mock.calls.length).toBe(baseline)
    expect(engine.getSyncCursor()).toBe("11")
    engine.destroy()
  })

  it("coalesces heartbeats during grace into one run and self-quiets once the head is seen", async () => {
    const catchUp = vi.fn().mockResolvedValue(emptyPage("10"))
    const { engine, socket } = await connectSettledEngine(catchUp)
    // The heartbeat-triggered run finds only entries invisible to this user.
    catchUp.mockResolvedValue(emptyPage("15"))
    const baseline = catchUp.mock.calls.length

    vi.useFakeTimers()
    socket.trigger("sync:heartbeat", heartbeat("12"))
    socket.trigger("sync:heartbeat", heartbeat("15"))
    vi.advanceTimersByTime(3_500)
    vi.useRealTimers()
    await vi.waitFor(() => expect(catchUp.mock.calls.length).toBeGreaterThan(baseline))
    const afterRun = catchUp.mock.calls.length

    // Same head again: lastSeenHead now covers it, so no second run.
    vi.useFakeTimers()
    socket.trigger("sync:heartbeat", heartbeat("15"))
    vi.advanceTimersByTime(10_000)
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(catchUp.mock.calls.length).toBe(afterRun)
    engine.destroy()
  })

  it("does not mark a head clean when the drain fails mid-way — the next heartbeat finishes it", async () => {
    const catchUp = vi.fn().mockResolvedValue(emptyPage("10"))
    const { engine, socket } = await connectSettledEngine(catchUp)
    // First heartbeat-triggered run: page 1 applies entry 11 (head reports
    // 15), then the next page's fetch fails — lastSeenHead must NOT record 15.
    catchUp
      .mockResolvedValueOnce({ entries: [userAddedEntry("11", "user_a")], head: "15" })
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ entries: [userAddedEntry("12", "user_b")], head: "15" })
      .mockResolvedValue(emptyPage("15"))

    vi.useFakeTimers()
    socket.trigger("sync:heartbeat", heartbeat("15"))
    vi.advanceTimersByTime(2_500)
    vi.useRealTimers()
    await vi.waitFor(async () => expect(await db.workspaceUsers.get("user_a")).toBeDefined())
    // Let the failed run settle fully before the retry heartbeat.
    await new Promise((resolve) => setTimeout(resolve, 0))

    vi.useFakeTimers()
    socket.trigger("sync:heartbeat", heartbeat("15"))
    vi.advanceTimersByTime(2_500)
    vi.useRealTimers()

    await vi.waitFor(async () => expect(await db.workspaceUsers.get("user_b")).toBeDefined())
    expect(engine.getSyncCursor()).toBe("12")
    engine.destroy()
  })

  it("ignores other workspaces' heartbeats and malformed heads", async () => {
    const catchUp = vi.fn().mockResolvedValue(emptyPage("10"))
    const { engine, socket } = await connectSettledEngine(catchUp)
    const baseline = catchUp.mock.calls.length

    vi.useFakeTimers()
    socket.trigger("sync:heartbeat", { workspaceId: "ws_other", head: "99" })
    socket.trigger("sync:heartbeat", { workspaceId: "ws_1", head: "not-a-number" })
    socket.trigger("sync:heartbeat", undefined)
    vi.advanceTimersByTime(10_000)
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(catchUp.mock.calls.length).toBe(baseline)
    engine.destroy()
  })

  it("destroy during the grace window cancels the pending catch-up", async () => {
    const catchUp = vi.fn().mockResolvedValue(emptyPage("10"))
    const { engine, socket } = await connectSettledEngine(catchUp)
    const baseline = catchUp.mock.calls.length

    vi.useFakeTimers()
    socket.trigger("sync:heartbeat", heartbeat("12"))
    engine.destroy()
    vi.advanceTimersByTime(10_000)
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(catchUp.mock.calls.length).toBe(baseline)
  })
})

describe("SyncEngine active-mode reconnect bootstrap slimming", () => {
  beforeEach(async () => {
    resetRevealGate()
    await Promise.all([
      db.workspaces.clear(),
      db.syncCursors.clear(),
      db.workspaceUsers.clear(),
      db.streams.clear(),
      db.streamMemberships.clear(),
      db.unreadState.clear(),
      db.labels.clear(),
      db.labelAssignments.clear(),
      db.events.clear(),
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function emptyPage(head: string): SyncCatchUpResponse {
    return { entries: [], head }
  }

  function makeReconnectDeps() {
    const catchUp = vi.fn(async () => emptyPage("0"))
    return {
      ...makeDeps(),
      syncService: { catchUp: catchUp as (...args: unknown[]) => Promise<SyncCatchUpResponse> },
    }
  }

  it("skips the full workspace snapshot on an active reconnect", async () => {
    const deps = makeReconnectDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    expect(deps.workspaceService.bootstrap).toHaveBeenCalledTimes(1)
    deps.workspaceService.bootstrap.mockClear()

    // Reconnect: catch-up replay re-seeds every workspace-scoped projection, so
    // the slim path skips the full snapshot refetch.
    await engine.onConnect(asSocket(socket))

    expect(deps.workspaceService.bootstrap).not.toHaveBeenCalled()
    engine.destroy()
  })

  it("re-subscribes member rooms from cached membership on a slim reconnect", async () => {
    const deps = makeReconnectDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    // Seed the membership AFTER the first bootstrap so its stale-delete reconcile
    // (the empty test bootstrap carries no memberships) can't clear it.
    await db.streamMemberships.put({
      id: "ws_1:stream_member",
      workspaceId: "ws_1",
      streamId: "stream_member",
      memberId: "user_1",
      notificationLevel: null,
      lastReadEventId: null,
      lastReadAt: null,
      joinedAt: new Date().toISOString(),
      _cachedAt: Date.now(),
    })
    socket.emittedEvents.length = 0

    await engine.onConnect(asSocket(socket))

    await vi.waitFor(() =>
      expect(socket.emittedEvents.some((e) => e.event === "join" && e.args[0] === "ws:ws_1:stream:stream_member")).toBe(
        true
      )
    )
    engine.destroy()
  })

  it("still fetches per-stream data for visible streams on a slim reconnect (per-stream cursor mechanism kept)", async () => {
    const deps = makeReconnectDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    // Mark a stream visible after the first connect; the slim reconnect must
    // still heal its timeline (a per-stream sequence, not the workspace
    // sync-log), so the per-stream bootstrap fetch fires for it.
    engine.setVisibleStreamIds(["stream_v"])
    deps.streamService.bootstrap.mockClear()

    await engine.onConnect(asSocket(socket))

    await vi.waitFor(() =>
      expect(deps.streamService.bootstrap.mock.calls.some((call) => call[1] === "stream_v")).toBe(true)
    )
    engine.destroy()
  })

  it("forces a full bootstrap when an active reconnect catch-up reports below the retention floor", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const catchUp = vi.fn().mockResolvedValue({ entries: [], head: "500", requiresBootstrap: true })
    const deps = { ...makeReconnectDeps(), syncService: { catchUp } }
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    // First connect: full bootstrap, then the below-floor fallback fires a
    // second full bootstrap and jumps the cursor to head.
    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(engine.getSyncCursor()).toBe("500"))
    deps.workspaceService.bootstrap.mockClear()

    // Reconnect: the slim path itself never fetches the snapshot, so a call
    // here proves the below-floor fallback ran as a forced full bootstrap.
    await engine.onConnect(asSocket(socket))

    await vi.waitFor(() => expect(deps.workspaceService.bootstrap).toHaveBeenCalled())
    engine.destroy()
  })

  it("keeps the full reconnect bootstrap without a sync service", async () => {
    const deps = makeDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    deps.workspaceService.bootstrap.mockClear()
    await engine.onConnect(asSocket(socket))

    expect(deps.workspaceService.bootstrap).toHaveBeenCalledTimes(1)
    engine.destroy()
  })

  it("slims an active-mode resume too — no full snapshot", async () => {
    const deps = makeReconnectDeps()
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    deps.workspaceService.bootstrap.mockClear()

    // Resume is reconnect-shaped: catch-up replay + the slim bootstrap re-seed
    // everything the full snapshot would, so resume takes the slim path in
    // active mode.
    await engine.refreshAfterConnectivityResume()

    expect(deps.workspaceService.bootstrap).not.toHaveBeenCalled()
    engine.destroy()
  })

  it("forces a full bootstrap on resume when catch-up reports below the retention floor", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const catchUp = vi.fn().mockResolvedValue({ entries: [], head: "500", requiresBootstrap: true })
    const deps = { ...makeReconnectDeps(), syncService: { catchUp } }
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(engine.getSyncCursor()).toBe("500"))
    deps.workspaceService.bootstrap.mockClear()

    // The slim resume path never fetches the snapshot itself, so a call here
    // proves the below-floor catch-up fallback forced a full bootstrap.
    await engine.refreshAfterConnectivityResume()

    await vi.waitFor(() => expect(deps.workspaceService.bootstrap).toHaveBeenCalled())
    engine.destroy()
  })
})
