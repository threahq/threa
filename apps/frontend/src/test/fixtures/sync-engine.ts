import { vi } from "vitest"
import type { Socket } from "socket.io-client"
import { QueryClient } from "@tanstack/react-query"
import { SyncStatusStore } from "@/sync/sync-status"
import {
  DEFAULT_USER_PREFERENCES,
  DEFAULT_WORKSPACE_SETTINGS,
  DEFAULT_SIDEBAR_CONFIG,
  type WorkspaceBootstrap,
  type StreamBootstrap,
} from "@threa/types"

type EventHandler = (...args: unknown[]) => void

export class MockSocket {
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

export function asSocket(mock: MockSocket): Socket {
  return mock as unknown as Socket
}

export function makeWorkspaceBootstrap(): WorkspaceBootstrap {
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
    featureFlags: { workspace: {}, user: {} },
    workspaceSettings: {
      ...DEFAULT_WORKSPACE_SETTINGS,
      workspaceId: "ws_1",
      createdAt: now,
      updatedAt: now,
    },
  } satisfies WorkspaceBootstrap
}

export function makeStreamBootstrap(streamId = "stream_1", sequence = "2"): StreamBootstrap {
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

export function makeDeps() {
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
