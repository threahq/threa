import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useQueueDraftMessage } from "./use-queue-draft-message"
import { StreamTypes, type JSONContent } from "@threa/types"
import * as dbModule from "@/db"
import * as contextsModule from "@/contexts"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as prosemirrorModule from "@threa/prosemirror"
import * as streamSyncModule from "@/sync/stream-sync"
import * as e2eSessionModule from "@/stores/e2e-session-store"
import * as streamKeyCacheModule from "@/lib/crypto/stream-key-cache"
import * as messageEnvelopeModule from "@/lib/crypto/message-envelope"

const WORKSPACE_ID = "ws_1"
const WORKOS_USER_ID = "workos_1"
const USER_ID = "user_1"
const ROOT_STREAM_ID = "stream_root"
const PANEL_ID = "draft_panel"

const CONTENT: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }

const mockMarkPending = vi.fn()
const mockNotifyQueue = vi.fn()
const mockPendingAdd = vi.fn().mockResolvedValue(undefined)
const mockEventsAdd = vi.fn().mockResolvedValue(undefined)

function setup() {
  return renderHook(() => useQueueDraftMessage(WORKSPACE_ID))
}

const threadCreation = {
  type: StreamTypes.THREAD,
  parentStreamId: "stream_parent",
  parentMessageId: "msg_parent",
}

describe("useQueueDraftMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockMarkPending.mockReset()
    mockNotifyQueue.mockReset()
    mockPendingAdd.mockClear()
    mockEventsAdd.mockClear()

    vi.spyOn(authModule, "useUser").mockReturnValue({ id: WORKOS_USER_ID } as ReturnType<typeof authModule.useUser>)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
      { workosUserId: WORKOS_USER_ID, id: USER_ID },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
    vi.spyOn(contextsModule, "usePendingMessages").mockReturnValue({
      markPending: mockMarkPending,
      notifyQueue: mockNotifyQueue,
    } as unknown as ReturnType<typeof contextsModule.usePendingMessages>)
    vi.spyOn(prosemirrorModule, "serializeToMarkdown").mockReturnValue("hi")
    vi.spyOn(streamSyncModule, "optimisticReplyCountUpdate").mockResolvedValue(undefined)
    vi.spyOn(dbModule.db.pendingMessages, "add").mockImplementation(((...args: unknown[]) =>
      mockPendingAdd(...args)) as unknown as typeof dbModule.db.pendingMessages.add)
    vi.spyOn(dbModule.db.events, "add").mockImplementation(((...args: unknown[]) =>
      mockEventsAdd(...args)) as unknown as typeof dbModule.db.events.add)
  })

  it("seals the body under the encrypted root and stores ciphertext on the pending message", async () => {
    vi.spyOn(e2eSessionModule, "getE2eSessionState").mockReturnValue({
      status: "unlocked",
      keyId: "key_1",
      privateKey: {} as CryptoKey,
    } as unknown as ReturnType<typeof e2eSessionModule.getE2eSessionState>)
    vi.spyOn(streamKeyCacheModule, "resolveCurrentStreamKey").mockResolvedValue({
      key: new Uint8Array(32),
      keyGeneration: 3,
    })
    const sealSpy = vi
      .spyOn(messageEnvelopeModule, "sealStreamMessage")
      .mockResolvedValue({
        ciphertext: "CT",
        envelope: { v: 2, keyGeneration: 3, iv: "iv", aad: "aad" },
        e2eVersion: 2,
      })

    const { result } = setup()
    await act(async () => {
      await result.current.queueDraftMessage(
        { contentJson: CONTENT },
        {
          workspaceId: WORKSPACE_ID,
          streamId: PANEL_ID,
          streamCreation: threadCreation,
          draftId: PANEL_ID,
          e2e: { rootStreamId: ROOT_STREAM_ID },
        }
      )
    })

    // The SSK and AAD are bound to the encrypted root, not the (not-yet-created) thread.
    expect(sealSpy).toHaveBeenCalledTimes(1)
    expect(sealSpy.mock.calls[0][0]).toMatchObject({ streamId: ROOT_STREAM_ID, keyGeneration: 3 })

    expect(mockPendingAdd).toHaveBeenCalledTimes(1)
    expect(mockPendingAdd.mock.calls[0][0]).toMatchObject({
      ciphertext: "CT",
      e2eVersion: 2,
      streamCreation: threadCreation,
    })
  })

  it("queues plaintext (no ciphertext) when the draft has no encrypted root", async () => {
    const sealSpy = vi.spyOn(messageEnvelopeModule, "sealStreamMessage")

    const { result } = setup()
    await act(async () => {
      await result.current.queueDraftMessage(
        { contentJson: CONTENT },
        {
          workspaceId: WORKSPACE_ID,
          streamId: PANEL_ID,
          streamCreation: threadCreation,
          draftId: PANEL_ID,
        }
      )
    })

    expect(sealSpy).not.toHaveBeenCalled()
    expect(mockPendingAdd).toHaveBeenCalledTimes(1)
    const pending = mockPendingAdd.mock.calls[0][0]
    expect(pending.ciphertext).toBeUndefined()
    expect(pending.e2eVersion).toBeUndefined()
  })

  it("refuses to queue an encrypted draft when the session is locked", async () => {
    vi.spyOn(e2eSessionModule, "getE2eSessionState").mockReturnValue({
      status: "locked",
      keyId: null,
      privateKey: null,
    } as unknown as ReturnType<typeof e2eSessionModule.getE2eSessionState>)

    const { result } = setup()
    await expect(
      result.current.queueDraftMessage(
        { contentJson: CONTENT },
        {
          workspaceId: WORKSPACE_ID,
          streamId: PANEL_ID,
          streamCreation: threadCreation,
          draftId: PANEL_ID,
          e2e: { rootStreamId: ROOT_STREAM_ID },
        }
      )
    ).rejects.toThrow(/Unlock encrypted scratchpads/)

    expect(mockPendingAdd).not.toHaveBeenCalled()
  })
})
