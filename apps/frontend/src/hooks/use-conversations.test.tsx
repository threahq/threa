import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import type { Socket } from "socket.io-client"
import type { ConversationWithStaleness } from "@threa/types"
import * as contextsModule from "@/contexts"
import * as syncEngineModule from "@/sync/sync-engine"
import { SocketEventGate } from "@/sync/socket-event-gate"
import { useConversations, conversationKeys } from "./use-conversations"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_1"

function createTestSocket() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()

  const socket = {
    on(event: string, handler: (payload: unknown) => void) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return this
    },
    off(event: string, handler: (payload: unknown) => void) {
      handlers.get(event)?.delete(handler)
      return this
    },
  } as unknown as Socket

  return {
    socket,
    emit(event: string, payload: unknown) {
      handlers.get(event)?.forEach((handler) => handler(payload))
    },
  }
}

function makeConversation(id: string): ConversationWithStaleness {
  return { id } as unknown as ConversationWithStaleness
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return { queryClient, wrapper }
}

function listKey() {
  return conversationKeys.list(WORKSPACE_ID, STREAM_ID, { status: undefined, limit: undefined })
}

describe("useConversations event registration", () => {
  let reconnectCount: number

  beforeEach(() => {
    vi.restoreAllMocks()
    reconnectCount = 0
    vi.spyOn(contextsModule, "useConversationService").mockReturnValue({
      listByStream: vi.fn().mockResolvedValue([]),
    } as unknown as contextsModule.ConversationService)
    vi.spyOn(contextsModule, "useSocketReconnectCount").mockImplementation(() => reconnectCount)
  })

  it("receives catch-up entries dispatched through the engine's event gate", async () => {
    const { socket } = createTestSocket()
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(socket)

    const gate = new SocketEventGate(WORKSPACE_ID)
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      getLiveEventSource: () => gate,
    } as unknown as syncEngineModule.SyncEngine)

    const { queryClient, wrapper } = createWrapper()
    renderHook(() => useConversations(WORKSPACE_ID, STREAM_ID), { wrapper })
    await waitFor(() => expect(queryClient.getQueryData(listKey())).toEqual([]))

    // Catch-up replay path: the engine pages the sync log and hands each
    // entry to gate.dispatch — never to the raw socket.
    await act(async () => {
      await gate.dispatch("conversation:created", {
        workspaceId: WORKSPACE_ID,
        streamId: STREAM_ID,
        conversation: makeConversation("conv_1"),
      })
    })

    expect(queryClient.getQueryData(listKey())).toEqual([makeConversation("conv_1")])

    gate.dispose()
  })

  it("falls back to raw socket registration without a sync engine", async () => {
    const { socket, emit } = createTestSocket()
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(socket)
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue(null)

    const { queryClient, wrapper } = createWrapper()
    renderHook(() => useConversations(WORKSPACE_ID, STREAM_ID), { wrapper })
    await waitFor(() => expect(queryClient.getQueryData(listKey())).toEqual([]))

    act(() => {
      emit("conversation:created", {
        workspaceId: WORKSPACE_ID,
        streamId: STREAM_ID,
        conversation: makeConversation("conv_1"),
      })
    })

    expect(queryClient.getQueryData(listKey())).toEqual([makeConversation("conv_1")])
  })

  it("still invalidates the list on socket reconnect without a sync engine", async () => {
    const { socket } = createTestSocket()
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(socket)
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue(null)

    const { queryClient, wrapper } = createWrapper()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    reconnectCount = 1
    renderHook(() => useConversations(WORKSPACE_ID, STREAM_ID), { wrapper })

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: listKey() }))
  })

  it.each(["off", "shadow"] as const)("keeps the reconnect invalidation in %s sync-v2 mode", async (mode) => {
    const { socket } = createTestSocket()
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(socket)

    const gate = new SocketEventGate(WORKSPACE_ID)
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      getLiveEventSource: () => gate,
      syncCursorMode: mode,
    } as unknown as syncEngineModule.SyncEngine)

    const { queryClient, wrapper } = createWrapper()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    reconnectCount = 1
    renderHook(() => useConversations(WORKSPACE_ID, STREAM_ID), { wrapper })

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: listKey() }))

    gate.dispose()
  })

  it("skips the reconnect invalidation in active sync-v2 mode (catch-up replay covers the gap)", async () => {
    const { socket } = createTestSocket()
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(socket)

    const gate = new SocketEventGate(WORKSPACE_ID)
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      getLiveEventSource: () => gate,
      syncCursorMode: "active",
    } as unknown as syncEngineModule.SyncEngine)

    const { queryClient, wrapper } = createWrapper()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    reconnectCount = 1
    renderHook(() => useConversations(WORKSPACE_ID, STREAM_ID), { wrapper })
    await waitFor(() => expect(queryClient.getQueryData(listKey())).toEqual([]))

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: listKey() })

    // The replay path the deleted healing is traded for: a gate-dispatched
    // catch-up entry still lands in the list cache.
    await act(async () => {
      await gate.dispatch("conversation:created", {
        workspaceId: WORKSPACE_ID,
        streamId: STREAM_ID,
        conversation: makeConversation("conv_1"),
      })
    })
    expect(queryClient.getQueryData(listKey())).toEqual([makeConversation("conv_1")])

    gate.dispose()
  })
})
