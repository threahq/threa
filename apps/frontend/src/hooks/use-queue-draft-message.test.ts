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

function mockUnlockedSession() {
  vi.spyOn(e2eSessionModule, "getE2eSessionState").mockReturnValue({
    status: "unlocked",
    keyId: "key_1",
    privateKey: {} as CryptoKey,
  } as unknown as ReturnType<typeof e2eSessionModule.getE2eSessionState>)
  vi.spyOn(streamKeyCacheModule, "resolveCurrentStreamKey").mockResolvedValue({
    key: new Uint8Array(32),
    keyGeneration: 3,
  })
  vi.spyOn(messageEnvelopeModule, "sealStreamMessage").mockResolvedValue({
    ciphertext: "CT",
    envelope: { v: 2, keyGeneration: 3, iv: "iv", aad: "aad" },
    e2eVersion: 2,
  })
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
    mockUnlockedSession()
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
          e2e: { rootStreamId: ROOT_STREAM_ID, hasActors: false },
        }
      )
    })

    // The SSK and AAD are bound to the encrypted root, not the (not-yet-created) thread.
    expect(sealSpy).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: ROOT_STREAM_ID, messageId: expect.any(String), keyGeneration: 3 })
    )
    expect(mockPendingAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        ciphertext: "CT",
        envelope: { v: 2, keyGeneration: 3, iv: "iv", aad: "aad" },
        e2eVersion: 2,
        streamCreation: threadCreation,
      })
    )
    // The optimistic event must carry contentJson so the post-promotion server
    // echo can seed the decrypt cache (stream-sync needs both markdown + JSON) —
    // otherwise an encrypted reply flashes the placeholder for its own author.
    expect(mockEventsAdd).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ contentJson: CONTENT }) })
    )
  })

  it("heals the encrypted root's actor wraps on send when the root has invited actors", async () => {
    mockUnlockedSession()
    const reviveSpy = vi.spyOn(streamKeyCacheModule, "reviveStaleActorWraps").mockResolvedValue("none-missing")

    const { result } = setup()
    await act(async () => {
      await result.current.queueDraftMessage(
        { contentJson: CONTENT },
        {
          workspaceId: WORKSPACE_ID,
          streamId: PANEL_ID,
          streamCreation: threadCreation,
          draftId: PANEL_ID,
          e2e: { rootStreamId: ROOT_STREAM_ID, hasActors: true },
        }
      )
    })

    expect(reviveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, streamId: ROOT_STREAM_ID, userId: USER_ID })
    )
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
    const pending = mockPendingAdd.mock.calls[0][0]
    expect({ ciphertext: pending.ciphertext, envelope: pending.envelope, e2eVersion: pending.e2eVersion }).toEqual({
      ciphertext: undefined,
      envelope: undefined,
      e2eVersion: undefined,
    })
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
          e2e: { rootStreamId: ROOT_STREAM_ID, hasActors: false },
        }
      )
    ).rejects.toThrow(/Unlock encrypted scratchpads/)

    expect(mockPendingAdd).not.toHaveBeenCalled()
  })
})
