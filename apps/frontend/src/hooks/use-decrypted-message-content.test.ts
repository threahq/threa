import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { StreamEvent } from "@threa/types"
import * as e2eSessionModule from "@/stores/e2e-session-store"
import * as decryptCacheModule from "@/lib/crypto/decrypt-cache"
import * as streamStoreModule from "@/stores/stream-store"
import { useDecryptedMessageContent } from "./use-decrypted-message-content"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_thread_1"
const USER_ID = "usr_1"

/** Stub the stream row a message's stream resolves to. `undefined` = not yet
 *  hydrated (root unknown); `null` rootStreamId = top-level; a string = thread. */
function mockStreamRow(row: { rootStreamId: string | null } | undefined): void {
  vi.spyOn(streamStoreModule, "useStreamFromStore").mockReturnValue(
    row as unknown as ReturnType<typeof streamStoreModule.useStreamFromStore>
  )
}

function unlockedSession(): void {
  vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
    status: "unlocked",
    privateKey: {} as CryptoKey,
    keyId: "key_1",
  } as unknown as ReturnType<typeof e2eSessionModule.useE2eSession>)
}

/** A sealed `message_created` event — Ariadne's reply on the wire is exactly this. */
function sealedEvent(): StreamEvent {
  return {
    id: "evt_1",
    streamId: STREAM_ID,
    sequence: "1",
    eventType: "message_created",
    payload: {
      messageId: "msg_1",
      ciphertext: "abc",
      envelope: { v: 2, keyGeneration: 1, iv: "x", aad: "y" },
      contentMarkdown: "​", // server placeholder
    },
    actorId: "persona_system_ariadne",
    actorType: "persona",
    createdAt: new Date().toISOString(),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("useDecryptedMessageContent", () => {
  it("returns locked for a sealed message while the session is locked", () => {
    vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
      status: "locked",
    } as unknown as ReturnType<typeof e2eSessionModule.useE2eSession>)
    mockStreamRow({ rootStreamId: "stream_root" })

    const { result } = renderHook(() => useDecryptedMessageContent(sealedEvent(), WORKSPACE_ID, USER_ID))

    expect(result.current).toEqual({ status: "locked" })
  })

  it("holds at pending without attempting a decrypt while the stream row is unhydrated", async () => {
    unlockedSession()
    mockStreamRow(undefined) // root unknown — resolving against the thread id would fail and cache forever
    vi.spyOn(decryptCacheModule, "getCachedDecryption").mockReturnValue(undefined)
    const requestSpy = vi.spyOn(decryptCacheModule, "requestDecryption").mockResolvedValue(undefined as never)

    const { result } = renderHook(() => useDecryptedMessageContent(sealedEvent(), WORKSPACE_ID, USER_ID))

    expect(result.current).toEqual({ status: "pending" })
    // The bug this guards: a doomed decrypt against the bare thread id, cached as
    // a permanent failure that never retries once the root is known.
    await new Promise((r) => setTimeout(r, 20))
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it("resolves a thread message's key against the root once the row hydrates", async () => {
    unlockedSession()
    mockStreamRow({ rootStreamId: "stream_root" })
    vi.spyOn(decryptCacheModule, "getCachedDecryption").mockReturnValue(undefined)
    const requestSpy = vi.spyOn(decryptCacheModule, "requestDecryption").mockResolvedValue(undefined as never)

    renderHook(() => useDecryptedMessageContent(sealedEvent(), WORKSPACE_ID, USER_ID))

    await waitFor(() => expect(requestSpy).toHaveBeenCalledTimes(1))
    const [, , opts] = requestSpy.mock.calls[0]!
    expect(opts.streamId).toBe(STREAM_ID)
    expect(opts.rootStreamId).toBe("stream_root")
  })

  it("returns the decrypted content from cache when available", () => {
    unlockedSession()
    mockStreamRow({ rootStreamId: "stream_root" })
    vi.spyOn(decryptCacheModule, "getCachedDecryption").mockReturnValue({
      status: "decrypted",
      content: { contentMarkdown: "hello from Ariadne", contentJson: { type: "doc" } as never, attachmentRefs: [] },
    })

    const { result } = renderHook(() => useDecryptedMessageContent(sealedEvent(), WORKSPACE_ID, USER_ID))

    expect(result.current).toMatchObject({ status: "decrypted", contentMarkdown: "hello from Ariadne" })
  })
})
