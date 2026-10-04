import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { StreamConnectionErrorCodes } from "@threahq/types"
import { toast } from "sonner"
import { ApiError } from "@/api"
import { messagesApi } from "@/api/messages"
import { db } from "@/db"
import * as syncEngineModule from "@/sync/sync-engine"
import * as workspaceEmojiModule from "./use-workspace-emoji"
import { useMessageReactions } from "./use-message-reactions"

const mockKickOperationQueue = vi.fn()

function setup() {
  return renderHook(() => useMessageReactions("ws_1", "msg_1")).result
}

async function queuedOperations() {
  return (await db.pendingOperations.toArray()).map(({ type, payload }) => ({ type, payload }))
}

beforeEach(async () => {
  vi.restoreAllMocks()
  mockKickOperationQueue.mockReset()
  await db.pendingOperations.clear()
  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
    kickOperationQueue: mockKickOperationQueue,
  } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)
  vi.spyOn(workspaceEmojiModule, "useWorkspaceEmoji").mockReturnValue({
    emojis: [],
    toEmoji: () => null,
  } as unknown as ReturnType<typeof workspaceEmojiModule.useWorkspaceEmoji>)
})

describe("useMessageReactions", () => {
  it("should toast an error and not queue the reaction when the server refuses it permanently", async () => {
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("e1")
    vi.spyOn(messagesApi, "addReaction").mockRejectedValue(
      new ApiError(403, StreamConnectionErrorCodes.WRITE_REFUSED, "Refused")
    )
    vi.spyOn(messagesApi, "removeReaction").mockRejectedValue(
      new ApiError(403, StreamConnectionErrorCodes.WRITE_REFUSED, "Refused")
    )
    const reactions = setup()

    await act(async () => {
      await reactions.current.addReaction("👍")
      await reactions.current.removeReaction("👍")
    })

    expect({
      errors: errorToast.mock.calls,
      queued: await queuedOperations(),
      kicks: mockKickOperationQueue.mock.calls.length,
    }).toEqual({
      errors: [["Couldn't add that reaction."], ["Couldn't remove that reaction."]],
      queued: [],
      kicks: 0,
    })
  })

  it("should queue the reaction when the request fails without a server verdict", async () => {
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("e2")
    vi.spyOn(messagesApi, "addReaction").mockRejectedValue(new TypeError("Failed to fetch"))
    vi.spyOn(messagesApi, "removeReaction").mockRejectedValue(new TypeError("Failed to fetch"))
    const reactions = setup()

    await act(async () => {
      await reactions.current.addReaction("👍")
      await reactions.current.removeReaction("👍")
    })

    expect({ errors: errorToast.mock.calls, queued: await queuedOperations() }).toEqual({
      errors: [],
      queued: [
        { type: "add_reaction", payload: { messageId: "msg_1", emoji: "👍" } },
        { type: "remove_reaction", payload: { messageId: "msg_1", emoji: "👍" } },
      ],
    })
  })
})
