import { describe, it, expect } from "vitest"
import type { CachedStream } from "@/db"
import type { E2eSessionState } from "@/stores/e2e-session-store"
import { isSessionUnlocked, resolveDecryptContext } from "../decrypt-context"

function session(overrides: Partial<E2eSessionState>): E2eSessionState {
  return {
    status: "unlocked",
    keyId: "e2ek_self",
    publicKey: null,
    privateKey: {} as CryptoKey,
    deviceTrusted: false,
    error: null,
    ...overrides,
  }
}

function streamRow(rootStreamId: string | null): CachedStream {
  return { rootStreamId } as unknown as CachedStream
}

describe("isSessionUnlocked", () => {
  it("is true only for an unlocked session with both keys present", () => {
    expect(isSessionUnlocked(session({}))).toBe(true)
    expect(isSessionUnlocked(session({ status: "locked" }))).toBe(false)
    expect(isSessionUnlocked(session({ privateKey: null }))).toBe(false)
    expect(isSessionUnlocked(session({ keyId: null }))).toBe(false)
  })
})

describe("resolveDecryptContext", () => {
  it("reports locked when the session can't decrypt", () => {
    const ctx = resolveDecryptContext("ws_1", "stream_1", session({ status: "locked" }), streamRow(null))
    expect(ctx).toEqual({ ready: false, reason: "locked" })
  })

  it("holds at unhydrated when the stream row is absent — the root is unknown", () => {
    const ctx = resolveDecryptContext("ws_1", "stream_thread", session({}), undefined)
    expect(ctx).toEqual({ ready: false, reason: "unhydrated" })
  })

  it("resolves a thread's key against its root once the row hydrates", () => {
    const ctx = resolveDecryptContext("ws_1", "stream_thread", session({}), streamRow("stream_root"))
    expect(ctx).toMatchObject({
      ready: true,
      opts: {
        workspaceId: "ws_1",
        streamId: "stream_thread",
        recipientKeyId: "e2ek_self",
        rootStreamId: "stream_root",
      },
    })
  })

  it("leaves rootStreamId undefined for a top-level stream (it is its own root)", () => {
    const ctx = resolveDecryptContext("ws_1", "stream_root", session({}), streamRow(null))
    expect(ctx.ready && ctx.opts.rootStreamId).toBeUndefined()
  })
})
