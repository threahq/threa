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

describe("SyncEngine sync-v2 cursor (shadow mode)", () => {
  beforeEach(async () => {
    resetRevealGate()
    await Promise.all([db.workspaces.clear(), db.syncCursors.clear()])
  })

  function makeShadowDeps(catchUp: ReturnType<typeof vi.fn>) {
    return {
      ...makeDeps(),
      syncService: { catchUp: catchUp as (...args: unknown[]) => Promise<SyncCatchUpResponse> },
      syncCursorMode: "shadow" as const,
    }
  }

  function emptyPage(head: string): SyncCatchUpResponse {
    return { entries: [], head }
  }

  function entry(syncId: string, eventType = "message:created"): SyncCatchUpResponse["entries"][number] {
    return { syncId, eventType, payload: {}, createdAt: new Date().toISOString() }
  }

  it("seeds the cursor from head on first run instead of replaying the log", async () => {
    const catchUp = vi.fn(async () => emptyPage("42"))
    const engine = new SyncEngine(makeShadowDeps(catchUp))

    await engine.onConnect(asSocket(new MockSocket()))

    await vi.waitFor(() => expect(engine.getSyncCursor()).toBe("42"))
    expect(catchUp).toHaveBeenCalledTimes(1)
    expect(catchUp).toHaveBeenCalledWith("ws_1", { after: "0", limit: 1 }, expect.any(AbortSignal))
    engine.destroy()
  })

  it("advances the cursor only from this workspace's live payloads carrying syncId", async () => {
    const catchUp = vi.fn(async () => emptyPage("5"))
    const engine = new SyncEngine(makeShadowDeps(catchUp))
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(engine.getSyncCursor()).toBe("5"))

    socket.trigger("message:created", { workspaceId: "ws_1", syncId: "7" })
    expect(engine.getSyncCursor()).toBe("7")

    // Lower id, other workspace, missing syncId: none move the cursor
    socket.trigger("message:created", { workspaceId: "ws_1", syncId: "6" })
    socket.trigger("message:created", { workspaceId: "ws_other", syncId: "9" })
    socket.trigger("stream:read", { workspaceId: "ws_1" })
    expect(engine.getSyncCursor()).toBe("7")
    engine.destroy()
  })

  it("pages catch-up from the persisted cursor until an empty page, advancing by fetched entries", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const catchUp = vi
      .fn()
      .mockResolvedValueOnce({ entries: [entry("11"), entry("12", "stream:read")], head: "12" })
      .mockResolvedValue(emptyPage("12"))
    const engine = new SyncEngine(makeShadowDeps(catchUp))

    await engine.onConnect(asSocket(new MockSocket()))

    await vi.waitFor(() => expect(engine.getSyncCursor()).toBe("12"))
    expect(catchUp).toHaveBeenNthCalledWith(1, "ws_1", { after: "10", limit: 500 }, expect.any(AbortSignal))
    expect(catchUp).toHaveBeenNthCalledWith(2, "ws_1", { after: "12", limit: 500 }, expect.any(AbortSignal))
    engine.destroy()
  })

  it("single-flights concurrent shadow catch-ups", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    let resolveFirst: ((value: SyncCatchUpResponse) => void) | undefined
    const catchUp = vi.fn(() => new Promise<SyncCatchUpResponse>((resolve) => (resolveFirst ??= resolve)))
    const engine = new SyncEngine(makeShadowDeps(catchUp))
    const socket = new MockSocket()
    await engine.onConnect(asSocket(socket))

    await engine.refreshAfterConnectivityResume()
    await engine.refreshAfterConnectivityResume()
    await vi.waitFor(() => expect(catchUp).toHaveBeenCalled())
    expect(catchUp).toHaveBeenCalledTimes(1)

    resolveFirst?.(emptyPage("10"))
    engine.destroy()
  })

  it("aborts an in-flight shadow catch-up on destroy", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    let capturedSignal: AbortSignal | undefined
    const catchUp = vi.fn((_workspaceId: unknown, _params: unknown, signal?: AbortSignal) => {
      capturedSignal = signal
      return new Promise<SyncCatchUpResponse>(() => {})
    })
    const engine = new SyncEngine(makeShadowDeps(catchUp))

    await engine.onConnect(asSocket(new MockSocket()))
    await vi.waitFor(() => expect(catchUp).toHaveBeenCalled())
    expect(capturedSignal?.aborted).toBe(false)

    engine.destroy()
    expect(capturedSignal?.aborted).toBe(true)
  })

  it("does nothing when the shadow flag is off", async () => {
    const catchUp = vi.fn(async () => emptyPage("42"))
    const deps = { ...makeShadowDeps(catchUp), syncCursorMode: "off" as const }
    const engine = new SyncEngine(deps)
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    socket.trigger("message:created", { workspaceId: "ws_1", syncId: "7" })

    expect(catchUp).not.toHaveBeenCalled()
    expect(engine.getSyncCursor()).toBeNull()
    engine.destroy()
  })
})

describe("SyncEngine sync-v2 cursor (active mode)", () => {
  beforeEach(async () => {
    resetRevealGate()
    await Promise.all([
      db.workspaces.clear(),
      db.syncCursors.clear(),
      db.workspaceUsers.clear(),
      db.unreadState.clear(),
    ])
  })

  function makeActiveDeps(catchUp: ReturnType<typeof vi.fn>) {
    return {
      ...makeDeps(),
      syncService: { catchUp: catchUp as (...args: unknown[]) => Promise<SyncCatchUpResponse> },
      syncCursorMode: "active" as const,
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

  it("skips LEGACY unread-counter entries (no absolute fields) but still advances the cursor past them", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    const catchUp = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [
          {
            syncId: "11",
            eventType: "activity:created",
            payload: {
              workspaceId: "ws_1",
              activity: { id: "act_1", streamId: "stream_x", activityType: "message", isSelf: false },
            },
            createdAt: new Date().toISOString(),
          },
          userAddedEntry("12", "user_a"),
        ],
        head: "12",
      })
      .mockResolvedValue(emptyPage("12"))
    const engine = new SyncEngine(makeActiveDeps(catchUp))

    await engine.onConnect(asSocket(new MockSocket()))

    await vi.waitFor(async () => expect(await db.workspaceUsers.get("user_a")).toBeDefined())
    expect(engine.getSyncCursor()).toBe("12")
    // The bootstrap wrote zeroed unread state; the skipped log entry must not
    // have incremented it (bootstrap stays the counter authority in 2b).
    const unread = await db.unreadState.get("ws_1")
    expect(unread?.unreadActivityCount).toBe(0)
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

  it("applies buffered LEGACY counter events at the splice even when at or below the catch-up position", async () => {
    await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
    let resolveFirstPage: ((value: SyncCatchUpResponse) => void) | undefined
    const catchUp = vi
      .fn()
      .mockImplementationOnce(() => new Promise<SyncCatchUpResponse>((resolve) => (resolveFirstPage = resolve)))
      .mockResolvedValue(emptyPage("12"))
    const engine = new SyncEngine(makeActiveDeps(catchUp))
    const socket = new MockSocket()

    await engine.onConnect(asSocket(socket))
    await vi.waitFor(() => expect(resolveFirstPage).toBeDefined())
    // Bootstrap has applied by now (onConnect awaited it) with zeroed counts.
    expect((await db.unreadState.get("ws_1"))?.unreadActivityCount).toBe(0)

    const activityPayload = {
      workspaceId: "ws_1",
      syncId: "11",
      activity: { id: "act_1", streamId: "stream_x", activityType: "message", isSelf: false },
    }
    socket.trigger("activity:created", activityPayload)

    // The same legacy event is also in the log (duplicate by design) —
    // catch-up skips it there; the buffered live copy applies exactly once
    // at splice.
    resolveFirstPage!({
      entries: [
        {
          syncId: "11",
          eventType: "activity:created",
          payload: activityPayload,
          createdAt: new Date().toISOString(),
        },
        userAddedEntry("12", "user_a"),
      ],
      head: "12",
    })

    await vi.waitFor(async () => {
      expect((await db.unreadState.get("ws_1"))?.unreadActivityCount).toBe(1)
    })
    expect((await db.unreadState.get("ws_1"))?.activityCounts["stream_x"]).toBe(1)
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

  function streamActivityEntry(syncId: string, messageOrdinal: number): SyncCatchUpResponse["entries"][number] {
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
          content: "hi",
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
