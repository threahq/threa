import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useMessageQueue } from "./use-message-queue"
import * as contextsModule from "@/contexts"
import * as syncEngineModule from "@/sync/sync-engine"
import * as dbModule from "@/db"
import * as prosemirrorModule from "@threa/prosemirror"
import * as draftPromotionsModule from "@/lib/draft-promotions"
import * as streamSyncModule from "@/sync/stream-sync"
import * as draftStoreModule from "@/stores/draft-store"
import * as boardStoreModule from "@/stores/board-store"
import * as useDraftMessageModule from "./use-draft-message"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MessageErrorCodes } from "@threa/types"
import { ApiError } from "@/api/client"
import { createElement, type ReactNode } from "react"

const mockCreate = vi.fn()
const mockMarkPending = vi.fn()
const mockMarkFailed = vi.fn()
const mockMarkSent = vi.fn()
const mockRegisterQueueNotify = vi.fn()
let mockIsConnected = true

const mockStreamCreate = vi.fn()

const mockSubscribeStream = vi.fn()
const mockKickOperationQueue = vi.fn()

interface MockPendingMessage {
  clientId: string
  workspaceId: string
  streamId: string
  content: string
  contentFormat: string
  contentJson?: { type: string; content: Array<{ type: string; content?: Array<{ type: string; text: string }> }> }
  attachmentIds?: string[]
  steer?: true
  status?: "editing" | "blocked-privacy"
  terminalFailure?: boolean
  createdAt: number
  retryCount: number
  retryAfter?: number
}

let mockPendingMessages: MockPendingMessage[] = []
const mockDelete = vi.fn().mockImplementation((id: string) => {
  mockPendingMessages = mockPendingMessages.filter((m) => m.clientId !== id)
  return Promise.resolve()
})
const mockUpdate = vi.fn().mockResolvedValue(1)

const mockEventsDelete = vi.fn().mockResolvedValue(undefined)
const mockEventsUpdate = vi.fn().mockResolvedValue(1)
const mockSetQueryData = vi.fn()

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.spyOn(client, "setQueryData").mockImplementation(((...args: unknown[]) =>
    mockSetQueryData(...args)) as unknown as typeof client.setQueryData)
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children)
  }
}

describe("useMessageQueue", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockCreate.mockReset()
    mockMarkPending.mockReset()
    mockMarkFailed.mockReset()
    mockMarkSent.mockReset()
    mockRegisterQueueNotify.mockReset()
    mockStreamCreate.mockReset()
    mockSubscribeStream.mockReset()
    mockKickOperationQueue.mockReset()
    mockDelete.mockClear()
    mockUpdate.mockClear()
    mockUpdate.mockResolvedValue(1)
    mockEventsDelete.mockClear()
    mockEventsDelete.mockResolvedValue(undefined)
    mockEventsUpdate.mockClear()
    mockEventsUpdate.mockResolvedValue(1)
    mockSetQueryData.mockReset()

    mockPendingMessages = []
    mockIsConnected = true
    mockCreate.mockResolvedValue({ id: "msg_1" })

    vi.spyOn(contextsModule, "useSocketConnected").mockImplementation(() => mockIsConnected)
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      create: mockCreate,
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)
    vi.spyOn(contextsModule, "useStreamService").mockReturnValue({
      create: mockStreamCreate,
    } as unknown as ReturnType<typeof contextsModule.useStreamService>)
    vi.spyOn(contextsModule, "usePendingMessages").mockReturnValue({
      markPending: mockMarkPending,
      markFailed: mockMarkFailed,
      markSent: mockMarkSent,
      registerQueueNotify: mockRegisterQueueNotify,
    } as unknown as ReturnType<typeof contextsModule.usePendingMessages>)

    vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
      subscribeStream: mockSubscribeStream,
      kickOperationQueue: mockKickOperationQueue,
    } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)

    vi.spyOn(dbModule.db.pendingMessages, "orderBy").mockReturnValue({
      toArray: () => Promise.resolve([...mockPendingMessages]),
    } as unknown as ReturnType<typeof dbModule.db.pendingMessages.orderBy>)
    vi.spyOn(dbModule.db.pendingMessages, "get").mockImplementation(((id: string) =>
      Promise.resolve(
        mockPendingMessages.find((m) => m.clientId === id)
      )) as unknown as typeof dbModule.db.pendingMessages.get)
    vi.spyOn(dbModule.db.pendingMessages, "delete").mockImplementation(((...args: unknown[]) =>
      mockDelete(...args)) as unknown as typeof dbModule.db.pendingMessages.delete)
    vi.spyOn(
      dbModule.db.pendingMessages as unknown as { update: (...args: unknown[]) => Promise<number> },
      "update"
    ).mockImplementation((...args: unknown[]) => mockUpdate(...args))

    vi.spyOn(dbModule.db.events, "get").mockResolvedValue(undefined as never)
    vi.spyOn(dbModule.db.events, "put").mockResolvedValue(undefined as never)
    vi.spyOn(dbModule.db.events, "delete").mockImplementation(((...args: unknown[]) =>
      mockEventsDelete(...args)) as unknown as typeof dbModule.db.events.delete)
    vi.spyOn(dbModule.db.events, "update").mockImplementation(((...args: unknown[]) =>
      mockEventsUpdate(...args)) as unknown as typeof dbModule.db.events.update)

    vi.spyOn(dbModule.db.streams, "put").mockResolvedValue(undefined as never)
    vi.spyOn(dbModule.db.streams, "delete").mockResolvedValue(undefined as never)
    vi.spyOn(dbModule.db.draftScratchpads, "delete").mockResolvedValue(undefined as never)

    // db.transaction is called with a variable table list (2- and 3-table forms);
    // invoke the LAST arg (the callback) regardless of how many tables precede it.
    vi.spyOn(dbModule.db, "transaction").mockImplementation(((...args: unknown[]) => {
      const fn = args[args.length - 1] as () => Promise<void>
      return fn()
    }) as unknown as typeof dbModule.db.transaction)

    vi.spyOn(dbModule, "sequenceToNum").mockImplementation((seq: string) => Number(seq))

    vi.spyOn(prosemirrorModule, "parseMarkdown").mockImplementation(
      (md: string) =>
        ({
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: md }] }],
        }) as unknown as ReturnType<typeof prosemirrorModule.parseMarkdown>
    )

    vi.spyOn(draftPromotionsModule, "emitDraftPromoted").mockImplementation(() => {})
    vi.spyOn(streamSyncModule, "setParentThreadId").mockResolvedValue(undefined as never)
    vi.spyOn(draftStoreModule, "deleteDraftScratchpadFromCache").mockImplementation(() => {})
    // Post-promotion draft re-pointing is exercised via its own tests; stub it here.
    vi.spyOn(useDraftMessageModule, "rescopeScopeDrafts").mockResolvedValue(undefined)
  })

  it("should register its notify callback on mount", () => {
    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })

    expect(mockRegisterQueueNotify).toHaveBeenCalledWith(expect.any(Function))
  })

  it("should process a pending message when connected", async () => {
    mockPendingMessages = [
      {
        clientId: "temp_abc",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Hello",
        contentFormat: "markdown",
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
        createdAt: 1000,
        retryCount: 0,
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })

    // Wait for async queue processing
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(mockMarkPending).toHaveBeenCalledWith("temp_abc")
    expect(mockCreate).toHaveBeenCalledWith("ws_1", "stream_1", {
      streamId: "stream_1",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
      attachmentIds: undefined,
      clientMessageId: "temp_abc",
    })
    expect(mockDelete).toHaveBeenCalledWith("temp_abc")
    expect(mockMarkSent).toHaveBeenCalledWith("temp_abc")
  })

  it("re-scopes card-thread stashes from the canonical anchor when promoting", async () => {
    mockStreamCreate.mockResolvedValue({
      id: "stream_real_thread",
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_parent",
      parentAnchorId: "event_card",
    })
    mockPendingMessages = [
      {
        clientId: "temp_card_reply",
        workspaceId: "ws_1",
        streamId: "draft:stream_parent:event_card",
        draftId: "draft:stream_parent:event_card",
        content: "Reply",
        contentFormat: "markdown",
        createdAt: 1000,
        retryCount: 0,
        streamCreation: {
          type: "thread",
          parentStreamId: "stream_parent",
          parentAnchorId: "event_card",
        },
      } as unknown as MockPendingMessage,
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })

    await waitFor(() =>
      expect(useDraftMessageModule.rescopeScopeDrafts).toHaveBeenCalledWith(
        "ws_1",
        "thread:event_card",
        "stream:stream_real_thread"
      )
    )
  })

  it("forwards atomic steer on the message request", async () => {
    mockPendingMessages = [
      {
        clientId: "temp_steer",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "I want option 2",
        contentFormat: "markdown",
        steer: true,
        createdAt: 1000,
        retryCount: 0,
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(mockCreate).toHaveBeenCalledWith(
      "ws_1",
      "stream_1",
      expect.objectContaining({ clientMessageId: "temp_steer", steer: true })
    )
  })

  it("should mark message as failed and increment retryCount when API call fails", async () => {
    mockCreate.mockRejectedValue(new Error("Network error"))
    mockPendingMessages = [
      {
        clientId: "temp_fail",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Fail",
        contentFormat: "markdown",
        createdAt: 1000,
        retryCount: 0,
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(mockUpdate).toHaveBeenCalledWith("temp_fail", {
      retryCount: 1,
      retryAfter: expect.any(Number),
    })
    expect(mockEventsUpdate).toHaveBeenCalledWith("temp_fail", { _status: "failed" })
    expect(mockMarkFailed).toHaveBeenCalledWith("temp_fail")
  })

  it("parks a message when its atomic steer is no longer available", async () => {
    mockCreate.mockRejectedValue(
      new ApiError(409, MessageErrorCodes.STEER_UNAVAILABLE, "Steer is not available in this stream")
    )
    mockPendingMessages = [
      {
        clientId: "temp_steer_gone",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Please handle this /steer",
        contentFormat: "markdown",
        steer: true,
        createdAt: 1000,
        retryCount: 0,
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(mockUpdate).toHaveBeenCalledWith("temp_steer_gone", {
      terminalFailure: true,
      retryAfter: undefined,
    })
    expect(mockEventsUpdate).toHaveBeenCalledWith("temp_steer_gone", { _status: "failed" })
    expect(mockMarkFailed).toHaveBeenCalledWith("temp_steer_gone")
  })

  it("does not auto-retry a permanently failed send", async () => {
    mockPendingMessages = [
      {
        clientId: "temp_permanent",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Please handle this /steer",
        contentFormat: "markdown",
        steer: true,
        terminalFailure: true,
        createdAt: 1000,
        retryCount: 0,
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("should retry high-retry-count messages (no max retry cap) with backoff", async () => {
    mockPendingMessages = [
      {
        clientId: "temp_many_retries",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Persistent",
        contentFormat: "markdown",
        createdAt: 1000,
        retryCount: 10,
        retryAfter: 0, // backoff expired, ready to retry
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // Should still attempt to send — no retry cap
    expect(mockCreate).toHaveBeenCalled()
    expect(mockMarkPending).toHaveBeenCalledWith("temp_many_retries")
  })

  it("should skip messages whose retryAfter has not passed", async () => {
    mockPendingMessages = [
      {
        clientId: "temp_backoff",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Waiting",
        contentFormat: "markdown",
        createdAt: 1000,
        retryCount: 5,
        retryAfter: Date.now() + 60_000, // 1 minute in the future
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // Should NOT attempt to send — backoff hasn't expired
    expect(mockCreate).not.toHaveBeenCalled()
    // Message stays in queue, not marked as failed
    expect(mockDelete).not.toHaveBeenCalled()
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it("should not attempt send or increment retryCount when offline", async () => {
    mockIsConnected = false
    mockPendingMessages = [
      {
        clientId: "temp_offline",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Offline msg",
        contentFormat: "markdown",
        createdAt: 1000,
        retryCount: 0,
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })

    // Trigger the queue via the registered notify callback
    const notifyFn = mockRegisterQueueNotify.mock.calls[0][0]
    await act(async () => {
      notifyFn()
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockMarkFailed).not.toHaveBeenCalled()
    expect(mockDelete).not.toHaveBeenCalled()
    // Message should still be in the queue untouched
    expect(mockPendingMessages).toHaveLength(1)
    expect(mockPendingMessages[0].retryCount).toBe(0)
  })

  it("should reset db.events._status to pending before retrying a failed message", async () => {
    mockPendingMessages = [
      {
        clientId: "temp_retry_status",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Retry me",
        contentFormat: "markdown",
        createdAt: 1000,
        retryCount: 1,
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // The first events.update call should be the _status: "pending" reset
    expect(mockEventsUpdate).toHaveBeenCalledWith("temp_retry_status", { _status: "pending" })
    expect(mockMarkPending).toHaveBeenCalledWith("temp_retry_status")
  })

  it("should deliver newer messages when an older message fails (no head-of-line blocking)", async () => {
    // Message A will fail, message B should still be delivered
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error("Server error"))
      return Promise.resolve({ id: "msg_b" })
    })

    mockPendingMessages = [
      {
        clientId: "temp_a",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Message A",
        contentFormat: "markdown",
        createdAt: 1000,
        retryCount: 0,
      },
      {
        clientId: "temp_b",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Message B",
        contentFormat: "markdown",
        createdAt: 2000,
        retryCount: 0,
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // A should have failed and been skipped
    expect(mockMarkFailed).toHaveBeenCalledWith("temp_a")
    // B should have been sent successfully
    expect(mockMarkSent).toHaveBeenCalledWith("temp_b")
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it("should process messages with attachmentIds", async () => {
    mockPendingMessages = [
      {
        clientId: "temp_attach",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "With attachments",
        contentFormat: "markdown",
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "With attachments" }] }],
        },
        attachmentIds: ["attach_1", "attach_2"],
        createdAt: 1000,
        retryCount: 0,
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(mockCreate).toHaveBeenCalledWith("ws_1", "stream_1", {
      streamId: "stream_1",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "With attachments" }] }],
      },
      attachmentIds: ["attach_1", "attach_2"],
      clientMessageId: "temp_attach",
    })
  })

  it("reconciles the optimistic board card to real ids once a new-scratchpad post's send returns", async () => {
    // A promoted scratchpad send: streamId is already the real stream, and the
    // send declares the fresh conversation (`intent: "new"`, carrying the
    // client-minted id) so the backend honors and returns it. (Promotion itself is
    // covered by its own tests.) The card was seeded at composer-clear under the
    // draft ids; the drain rewrites it to the real ones.
    const realStream = { id: "stream_real", type: "scratchpad", rootStreamId: null }
    vi.spyOn(dbModule.db.streams, "get").mockResolvedValue(realStream as never)
    mockCreate.mockResolvedValue({
      message: {
        id: "msg_1",
        authorId: "usr_1",
        contentMarkdown: "first note",
        streamId: "stream_real",
        createdAt: "2026-07-08T12:00:00.000Z",
      },
      conversationId: "conv_new",
    })
    const reconcile = vi.spyOn(boardStoreModule, "reconcileOptimisticBoardPost").mockResolvedValue(undefined)

    mockPendingMessages = [
      {
        clientId: "temp_scratch",
        workspaceId: "ws_1",
        streamId: "stream_real",
        content: "first note",
        contentFormat: "markdown",
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "first note" }] }] },
        createdAt: 1000,
        retryCount: 0,
        conversation: { intent: "new", conversationId: "conv_new" },
      } as unknown as MockPendingMessage,
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // The card reconciles to the real conversation + stream + message ids the
    // moment the scratchpad materializes.
    expect(reconcile).toHaveBeenCalledWith(
      "ws_1",
      expect.objectContaining({
        conversationId: "conv_new",
        messageId: "msg_1",
        streamId: "stream_real",
        authorId: "usr_1",
        contentMarkdown: "first note",
        rootStreamId: "stream_real",
        rootStreamType: "scratchpad",
      })
    )
  })

  it("does not touch a board card for an ordinary send that declared no new conversation", async () => {
    const reconcile = vi.spyOn(boardStoreModule, "reconcileOptimisticBoardPost").mockResolvedValue(undefined)
    mockPendingMessages = [
      {
        clientId: "temp_plain",
        workspaceId: "ws_1",
        streamId: "stream_1",
        content: "Hello",
        contentFormat: "markdown",
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
        createdAt: 1000,
        retryCount: 0,
      },
    ]

    renderHook(() => useMessageQueue(), { wrapper: createWrapper() })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(reconcile).not.toHaveBeenCalled()
  })
})
