import { describe, it, expect, vi, beforeEach } from "vitest"
import { spyOnExport } from "@/test/spy"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { PendingMessagesProvider, usePendingMessages } from "./pending-messages-context"
import * as dbModule from "@/db"
import * as boardStoreModule from "@/stores/board-store"

const mockGet = vi.fn()
const mockUpdate = vi.fn().mockResolvedValue(1)
const mockDelete = vi.fn().mockResolvedValue(undefined)
const mockEventsGet = vi.fn()
const mockEventsUpdate = vi.fn().mockResolvedValue(1)
const mockEventsPut = vi.fn().mockResolvedValue(undefined)
const mockEventsDelete = vi.fn().mockResolvedValue(undefined)
let mockHydratedPendingIds: string[] = []
let mockHydratedFailedIds: string[] = []
let mockHydratedEditingIds: string[] = []

const fakeDb = {
  pendingMessages: {
    get: (...args: unknown[]) => mockGet(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
  events: {
    get: (...args: unknown[]) => mockEventsGet(...args),
    update: (...args: unknown[]) => mockEventsUpdate(...args),
    put: (...args: unknown[]) => mockEventsPut(...args),
    delete: (...args: unknown[]) => mockEventsDelete(...args),
    where: (field: string) => ({
      equals: (value: string) => ({
        primaryKeys: () => {
          if (field !== "_status") return Promise.resolve([])
          if (value === "pending") return Promise.resolve(mockHydratedPendingIds)
          if (value === "failed") return Promise.resolve(mockHydratedFailedIds)
          if (value === "editing") return Promise.resolve(mockHydratedEditingIds)
          return Promise.resolve([])
        },
      }),
    }),
  },
  // Dexie transaction — execute the callback immediately for tests
  transaction: (_mode: string, ..._tables: unknown[]) => {
    const cb = _tables[_tables.length - 1]
    if (typeof cb === "function") return cb()
  },
} as unknown as typeof dbModule.db

function wrapper({ children }: { children: ReactNode }) {
  return <PendingMessagesProvider>{children}</PendingMessagesProvider>
}

describe("PendingMessagesContext", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    spyOnExport(dbModule, "db").mockReturnValue(fakeDb)
    mockGet.mockReset()
    mockUpdate.mockReset().mockResolvedValue(1)
    mockDelete.mockReset().mockResolvedValue(undefined)
    mockEventsGet.mockReset()
    mockEventsUpdate.mockReset().mockResolvedValue(1)
    mockEventsPut.mockReset().mockResolvedValue(undefined)
    mockEventsDelete.mockReset().mockResolvedValue(undefined)
    mockHydratedPendingIds = []
    mockHydratedFailedIds = []
    mockHydratedEditingIds = []
  })

  describe("retryMessage", () => {
    it("should bail out when the message no longer exists in IndexedDB", async () => {
      mockGet.mockResolvedValue(undefined)

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      // Mark message as failed first so we can verify it stays failed
      act(() => result.current.markFailed("temp_gone"))

      await act(async () => {
        await result.current.retryMessage("temp_gone")
      })

      expect(mockGet).toHaveBeenCalledWith("temp_gone")
      // Should NOT have attempted any DB update or UI state change
      expect(mockUpdate).not.toHaveBeenCalled()
      expect(mockEventsUpdate).not.toHaveBeenCalled()
      // Status should remain "failed", not flip to "pending"
      expect(result.current.getStatus("temp_gone")).toBe("failed")
    })

    it("should reset retryCount and re-enqueue when the message exists", async () => {
      mockGet.mockResolvedValue({ clientId: "temp_retry", retryCount: 2 })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      act(() => result.current.markFailed("temp_retry"))

      await act(async () => {
        await result.current.retryMessage("temp_retry")
      })

      expect(mockUpdate).toHaveBeenCalledWith("temp_retry", {
        retryCount: 0,
        retryAfter: 0,
        status: undefined,
        terminalFailure: undefined,
      })
      expect(mockEventsUpdate).toHaveBeenCalledWith("temp_retry", { _status: "pending" })
      expect(result.current.getStatus("temp_retry")).toBe("pending")
    })
  })

  describe("markEditing", () => {
    it("should transition a pending message to editing status", async () => {
      mockGet.mockResolvedValue({ clientId: "temp_edit", retryCount: 0 })
      mockEventsGet.mockResolvedValue({ _status: "pending" })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      act(() => result.current.markPending("temp_edit"))
      expect(result.current.getStatus("temp_edit")).toBe("pending")

      await act(async () => {
        await result.current.markEditing("temp_edit")
      })

      expect(mockUpdate).toHaveBeenCalledWith("temp_edit", { status: "editing", preEditStatus: "pending" })
      expect(mockEventsUpdate).toHaveBeenCalledWith("temp_edit", { _status: "editing" })
      expect(result.current.getStatus("temp_edit")).toBe("editing")
    })

    it("should transition a failed message to editing status", async () => {
      mockGet.mockResolvedValue({ clientId: "temp_edit_fail", retryCount: 3 })
      mockEventsGet.mockResolvedValue({ _status: "failed" })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      act(() => result.current.markFailed("temp_edit_fail"))

      await act(async () => {
        await result.current.markEditing("temp_edit_fail")
      })

      expect(result.current.getStatus("temp_edit_fail")).toBe("editing")
    })

    it("should bail out when the message no longer exists", async () => {
      mockGet.mockResolvedValue(undefined)

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      act(() => result.current.markPending("temp_gone"))

      await act(async () => {
        await result.current.markEditing("temp_gone")
      })

      // Should remain pending since markEditing bailed
      expect(result.current.getStatus("temp_gone")).toBe("pending")
    })
  })

  describe("cancelEditing", () => {
    it("should restore a previously-pending message to pending", async () => {
      // Setup: mark pending, then edit
      mockGet.mockResolvedValue({ clientId: "temp_cancel", retryCount: 0, status: undefined })
      mockEventsGet.mockResolvedValue({ _status: "pending" })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      act(() => result.current.markPending("temp_cancel"))

      await act(async () => {
        await result.current.markEditing("temp_cancel")
      })
      expect(result.current.getStatus("temp_cancel")).toBe("editing")

      await act(async () => {
        await result.current.cancelEditing("temp_cancel")
      })

      expect(result.current.getStatus("temp_cancel")).toBe("pending")
    })

    it("should restore a previously-failed message to failed", async () => {
      mockGet.mockResolvedValue({ clientId: "temp_cancel_fail", retryCount: 3, status: undefined })
      mockEventsGet.mockResolvedValue({ _status: "failed" })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      act(() => result.current.markFailed("temp_cancel_fail"))

      await act(async () => {
        await result.current.markEditing("temp_cancel_fail")
      })
      expect(result.current.getStatus("temp_cancel_fail")).toBe("editing")

      await act(async () => {
        await result.current.cancelEditing("temp_cancel_fail")
      })

      expect(result.current.getStatus("temp_cancel_fail")).toBe("failed")
    })
  })

  describe("startup hydration", () => {
    it("restores persisted editing messages to pending instead of reopening edit mode", async () => {
      mockHydratedEditingIds = ["temp_restore_pending"]
      mockGet.mockResolvedValue({
        clientId: "temp_restore_pending",
        status: "editing",
        preEditStatus: "pending",
      })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("temp_restore_pending", {
          status: undefined,
          preEditStatus: undefined,
        })
      })

      expect(mockEventsUpdate).toHaveBeenCalledWith("temp_restore_pending", { _status: "pending" })
      expect(result.current.getStatus("temp_restore_pending")).toBe("pending")
    })

    it("kicks the queue when startup hydration restores a pending message", async () => {
      vi.useFakeTimers()
      try {
        mockHydratedEditingIds = ["temp_restore_notify"]
        mockGet.mockResolvedValue({
          clientId: "temp_restore_notify",
          status: "editing",
          preEditStatus: "pending",
        })

        const { result } = renderHook(() => usePendingMessages(), { wrapper })
        const notifyQueue = vi.fn()
        act(() => {
          result.current.registerQueueNotify(notifyQueue)
        })

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        expect(mockUpdate).toHaveBeenCalledWith("temp_restore_notify", {
          status: undefined,
          preEditStatus: undefined,
        })
        expect(notifyQueue).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it("restores persisted editing messages to failed when they were editing a failed send", async () => {
      mockHydratedEditingIds = ["temp_restore_failed"]
      mockGet.mockResolvedValue({
        clientId: "temp_restore_failed",
        status: "editing",
        preEditStatus: "failed",
      })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith("temp_restore_failed", {
          status: undefined,
          preEditStatus: undefined,
        })
      })

      expect(mockEventsUpdate).toHaveBeenCalledWith("temp_restore_failed", { _status: "failed" })
      expect(result.current.getStatus("temp_restore_failed")).toBe("failed")
    })
  })

  describe("saveEditedMessage", () => {
    it("should update content and return to pending status", async () => {
      mockGet.mockResolvedValue({ clientId: "temp_save", retryCount: 0, content: "old" })
      mockEventsGet.mockResolvedValue({
        id: "temp_save",
        payload: { contentMarkdown: "old" },
        _status: "editing",
      })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      act(() => result.current.markPending("temp_save"))

      await act(async () => {
        await result.current.markEditing("temp_save")
      })
      expect(result.current.getStatus("temp_save")).toBe("editing")

      const newContent = { type: "doc" as const, content: [{ type: "paragraph" as const }] }
      await act(async () => {
        await result.current.saveEditedMessage("temp_save", newContent)
      })

      expect(result.current.getStatus("temp_save")).toBe("pending")
      // Should have updated the pending message
      expect(mockUpdate).toHaveBeenCalledWith(
        "temp_save",
        expect.objectContaining({
          status: undefined,
          preEditStatus: undefined,
          retryCount: 0,
          retryAfter: 0,
          terminalFailure: undefined,
          steer: undefined,
        })
      )
    })

    it.each([
      {
        name: "clears steer when the token is removed",
        existingSteer: true,
        contentJson: {
          type: "doc" as const,
          content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "plain edit" }] }],
        },
        steerAvailable: true,
        expectedSteer: undefined,
      },
      {
        name: "sets steer when mixed content adds the token",
        existingSteer: undefined,
        contentJson: {
          type: "doc" as const,
          content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "redirect this /steer" }] }],
        },
        steerAvailable: true,
        expectedSteer: true,
      },
      {
        name: "does not arm steer when the command is unavailable",
        existingSteer: undefined,
        contentJson: {
          type: "doc" as const,
          content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "mention /steer" }] }],
        },
        steerAvailable: false,
        expectedSteer: undefined,
      },
      {
        name: "does not turn a bare steer edit into a composite message",
        existingSteer: undefined,
        contentJson: {
          type: "doc" as const,
          content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "/steer" }] }],
        },
        steerAvailable: true,
        expectedSteer: undefined,
      },
    ])("$name", async ({ existingSteer, contentJson, steerAvailable, expectedSteer }) => {
      mockGet.mockResolvedValue({ clientId: "temp_steer_edit", steer: existingSteer })
      mockEventsGet.mockResolvedValue({
        id: "temp_steer_edit",
        payload: { contentMarkdown: "old" },
        _status: "editing",
      })
      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      await act(async () => {
        await result.current.saveEditedMessage("temp_steer_edit", contentJson, { steerAvailable })
      })

      expect(mockUpdate).toHaveBeenCalledWith(
        "temp_steer_edit",
        expect.objectContaining({ steer: expectedSteer, terminalFailure: undefined })
      )
    })
  })

  describe("deleteMessage", () => {
    it("should remove from both IDB tables and clear all state sets", async () => {
      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      act(() => result.current.markPending("temp_del"))

      await act(async () => {
        await result.current.deleteMessage("temp_del")
      })

      expect(mockDelete).toHaveBeenCalledWith("temp_del")
      expect(mockEventsDelete).toHaveBeenCalledWith("temp_del")
      expect(result.current.getStatus("temp_del")).toBeNull()
    })

    it("drops the optimistic board card when a cancelled new-scratchpad post is deleted", async () => {
      const dropCard = vi.fn().mockResolvedValue(undefined)
      spyOnExport(boardStoreModule, "deleteOptimisticBoardPost").mockReturnValue(dropCard)
      mockGet.mockResolvedValue({
        clientId: "temp_board",
        retryCount: 0,
        status: undefined,
        conversation: { intent: "new", conversationId: "conv_board" },
      })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      await act(async () => {
        await result.current.deleteMessage("temp_board")
      })

      expect(mockDelete).toHaveBeenCalledWith("temp_board")
      expect(dropCard).toHaveBeenCalledWith("conv_board")
    })

    it("leaves the board untouched when deleting a non-board pending message", async () => {
      const dropCard = vi.fn().mockResolvedValue(undefined)
      spyOnExport(boardStoreModule, "deleteOptimisticBoardPost").mockReturnValue(dropCard)
      mockGet.mockResolvedValue({ clientId: "temp_plain", retryCount: 0, status: undefined })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      await act(async () => {
        await result.current.deleteMessage("temp_plain")
      })

      expect(dropCard).not.toHaveBeenCalled()
    })

    it("should clear editing state when deleting an editing message", async () => {
      mockGet.mockResolvedValue({ clientId: "temp_del_edit", retryCount: 0, status: undefined })
      mockEventsGet.mockResolvedValue({ _status: "pending" })

      const { result } = renderHook(() => usePendingMessages(), { wrapper })

      act(() => result.current.markPending("temp_del_edit"))

      await act(async () => {
        await result.current.markEditing("temp_del_edit")
      })
      expect(result.current.getStatus("temp_del_edit")).toBe("editing")

      await act(async () => {
        await result.current.deleteMessage("temp_del_edit")
      })

      expect(result.current.getStatus("temp_del_edit")).toBeNull()
    })
  })
})
