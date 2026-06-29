import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import type { Socket } from "socket.io-client"
import { StreamTypes, type ConversationWithStaleness } from "@threa/types"
import * as contextsModule from "@/contexts"
import * as syncEngineModule from "@/sync/sync-engine"
import * as draftScratchpadsModule from "./use-draft-scratchpads"
import * as queueDraftModule from "./use-queue-draft-message"
import { SocketEventGate } from "@/sync/socket-event-gate"
import { useConversations, useCreateBoardPost, useReplyToBoardPost, conversationKeys } from "./use-conversations"

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

  it("skips the reconnect invalidation when a sync engine is mounted (catch-up replay covers the gap)", async () => {
    const { socket } = createTestSocket()
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(socket)

    const gate = new SocketEventGate(WORKSPACE_ID)
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      getLiveEventSource: () => gate,
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

describe("useCreateBoardPost", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function mockBoardDeps() {
    const create = vi.fn().mockResolvedValue({})
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      create,
    } as unknown as contextsModule.MessageService)
    const createScratchpad = vi.fn().mockResolvedValue("draft_1")
    vi.spyOn(draftScratchpadsModule, "useDraftScratchpads").mockReturnValue({
      createScratchpad,
    } as unknown as ReturnType<typeof draftScratchpadsModule.useDraftScratchpads>)
    const queueDraftMessage = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(queueDraftModule, "useQueueDraftMessage").mockReturnValue({
      queueDraftMessage,
      currentUserId: "user_1",
    } as unknown as ReturnType<typeof queueDraftModule.useQueueDraftMessage>)
    return { create, createScratchpad, queueDraftMessage }
  }

  it("posts to an existing stream as a new-conversation message with an idempotency key (no scratchpad created)", async () => {
    const { create, createScratchpad, queueDraftMessage } = mockBoardDeps()

    const { queryClient, wrapper } = createWrapper()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useCreateBoardPost(WORKSPACE_ID), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        target: { type: "stream", streamId: STREAM_ID },
        contentJson: { type: "doc", content: [] },
      })
    })

    expect(createScratchpad).not.toHaveBeenCalled()
    expect(queueDraftMessage).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith(
      WORKSPACE_ID,
      STREAM_ID,
      expect.objectContaining({
        streamId: STREAM_ID,
        contentJson: { type: "doc", content: [] },
        conversation: { intent: "new" },
        clientMessageId: expect.any(String),
      })
    )
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [...conversationKeys.all, "workspaceList", WORKSPACE_ID],
    })
  })

  it("creates a draft scratchpad and queues the first message via the promote-on-send queue (no eager server stream)", async () => {
    const { create, createScratchpad, queueDraftMessage } = mockBoardDeps()

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useCreateBoardPost(WORKSPACE_ID), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        target: { type: "newScratchpad", companionMode: "on" },
        contentJson: { type: "doc", content: [] },
      })
    })

    expect(create).not.toHaveBeenCalled()
    expect(createScratchpad).toHaveBeenCalledWith("on")
    expect(queueDraftMessage).toHaveBeenCalledWith(
      { contentJson: { type: "doc", content: [] }, attachmentIds: undefined },
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        streamId: "draft_1",
        draftId: "draft_1",
        streamCreation: { type: StreamTypes.SCRATCHPAD, companionMode: "on" },
      })
    )
  })
})

describe("useReplyToBoardPost", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function mockReplyDeps() {
    const queueDraftMessage = vi.fn().mockResolvedValue({ clientId: "temp_abc" })
    vi.spyOn(queueDraftModule, "useQueueDraftMessage").mockReturnValue({
      queueDraftMessage,
      currentUserId: "user_1",
    } as unknown as ReturnType<typeof queueDraftModule.useQueueDraftMessage>)
    return { queueDraftMessage }
  }

  const DOC = { type: "doc", content: [] }

  it("replies flat into a lone channel root's own stream via the existing directive (no new thread)", async () => {
    const { queueDraftMessage } = mockReplyDeps()
    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useReplyToBoardPost(WORKSPACE_ID), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        conversation: { id: "conv_1", streamId: "chan_1" },
        contentJson: DOC,
      })
    })

    // A board reply always joins the conversation in place — even a lone root
    // attaches via the existing directive rather than promoting a draft thread,
    // so the reply renders under the card it came from.
    expect(queueDraftMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contentJson: DOC }),
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        streamId: "chan_1",
        conversation: { intent: "existing", conversationId: "conv_1" },
      })
    )
    expect(queueDraftMessage.mock.calls[0][1]).not.toHaveProperty("streamCreation")
  })

  it("replies straight into a thread card's own stream via the existing directive", async () => {
    const { queueDraftMessage } = mockReplyDeps()
    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useReplyToBoardPost(WORKSPACE_ID), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        conversation: { id: "conv_thread", streamId: "thread_x" },
        contentJson: DOC,
      })
    })

    expect(queueDraftMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contentJson: DOC }),
      expect.objectContaining({
        streamId: "thread_x",
        conversation: { intent: "existing", conversationId: "conv_thread" },
      })
    )
  })
})
