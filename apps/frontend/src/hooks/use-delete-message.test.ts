import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { StreamConnectionErrorCodes } from "@threahq/types"
import { toast } from "sonner"
import * as contextsModule from "@/contexts"
import { ApiError } from "@/api"
import { db } from "@/db"
import { useDeleteMessage } from "./use-delete-message"

const mockDelete = vi.fn()

async function deleteMessage() {
  const { result } = renderHook(() => useDeleteMessage("ws_1"))
  await act(async () => {
    await result.current.deleteMessage("msg_1")
  })
}

beforeEach(async () => {
  vi.restoreAllMocks()
  mockDelete.mockReset()
  await db.pendingOperations.clear()
  vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
    delete: mockDelete,
  } as unknown as ReturnType<typeof contextsModule.useMessageService>)
})

describe("useDeleteMessage", () => {
  it("should toast an error and not queue the delete when the server refuses it permanently", async () => {
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("e1")
    const infoToast = vi.spyOn(toast, "info").mockReturnValue("i1")
    mockDelete.mockRejectedValue(new ApiError(403, StreamConnectionErrorCodes.WRITE_REFUSED, "Refused"))

    await deleteMessage()

    expect({
      errors: errorToast.mock.calls,
      infos: infoToast.mock.calls,
      queued: await db.pendingOperations.toArray(),
    }).toEqual({ errors: [["Couldn't delete that message."]], infos: [], queued: [] })
  })

  it("should queue the delete when the request fails without a server verdict", async () => {
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("e2")
    const infoToast = vi.spyOn(toast, "info").mockReturnValue("i2")
    mockDelete.mockRejectedValue(new TypeError("Failed to fetch"))

    await deleteMessage()

    expect({
      errors: errorToast.mock.calls,
      infos: infoToast.mock.calls,
      queued: (await db.pendingOperations.toArray()).map(({ type, payload }) => ({ type, payload })),
    }).toEqual({
      errors: [],
      infos: [["Delete queued — will complete when back online"]],
      queued: [{ type: "delete_message", payload: { messageId: "msg_1" } }],
    })
  })

  it("should queue the delete when the server is temporarily unavailable", async () => {
    vi.spyOn(toast, "info").mockReturnValue("i3")
    mockDelete.mockRejectedValue(new ApiError(503, StreamConnectionErrorCodes.HOST_UNREACHABLE, "Unreachable"))

    await deleteMessage()

    expect((await db.pendingOperations.toArray()).map(({ type }) => type)).toEqual(["delete_message"])
  })
})
