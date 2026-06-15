import { afterEach, describe, expect, it, vi } from "vitest"
import { sealStreamRename, StreamNameSealUnavailableError } from "../stream-rename"
import * as e2eSession from "@/stores/e2e-session-store"
import * as streamKeyCache from "../stream-key-cache"
import * as messageEnvelope from "../message-envelope"
import { clearStreamNameCache, getCachedStreamName, streamNameCacheKey } from "../stream-name-cache"

const WS = "ws_1"
const STREAM = "stream_01"
const USER = "usr_alice"

type SessionState = ReturnType<typeof e2eSession.getE2eSessionState>

function lockedSession(): SessionState {
  return {
    status: "locked",
    keyId: null,
    publicKey: null,
    privateKey: null,
    deviceTrusted: false,
    error: null,
  } as SessionState
}

function unlockedSession(): SessionState {
  return {
    status: "unlocked",
    keyId: "e2ek_alice",
    publicKey: null,
    privateKey: {} as CryptoKey,
    deviceTrusted: false,
    error: null,
  } as SessionState
}

afterEach(() => {
  vi.restoreAllMocks()
  clearStreamNameCache()
})

describe("sealStreamRename", () => {
  it("throws instead of falling back to plaintext when the session is locked", async () => {
    vi.spyOn(e2eSession, "getE2eSessionState").mockReturnValue(lockedSession())
    const sealSpy = vi.spyOn(messageEnvelope, "sealStreamName")

    await expect(
      sealStreamRename({ workspaceId: WS, streamId: STREAM, userId: USER, name: "Therapy notes" })
    ).rejects.toBeInstanceOf(StreamNameSealUnavailableError)
    // The whole point: a locked rename must never reach the seal/plaintext write.
    expect(sealSpy).not.toHaveBeenCalled()
  })

  it("throws when the stream key can't be resolved (not a recipient)", async () => {
    vi.spyOn(e2eSession, "getE2eSessionState").mockReturnValue(unlockedSession())
    vi.spyOn(streamKeyCache, "resolveCurrentStreamKey").mockResolvedValue(null)

    await expect(
      sealStreamRename({ workspaceId: WS, streamId: STREAM, userId: USER, name: "Therapy notes" })
    ).rejects.toMatchObject({ reason: "no-stream-key" })
  })

  it("returns only the sealed fields (no plaintext) when unlocked", async () => {
    vi.spyOn(e2eSession, "getE2eSessionState").mockReturnValue(unlockedSession())
    vi.spyOn(streamKeyCache, "resolveCurrentStreamKey").mockResolvedValue({
      key: new Uint8Array(32),
      keyGeneration: 0,
    } as never)
    vi.spyOn(messageEnvelope, "sealStreamName").mockResolvedValue({
      ciphertext: "Y3Q=",
      envelope: { v: 1 } as never,
    })

    const fields = await sealStreamRename({ workspaceId: WS, streamId: STREAM, userId: USER, name: "Therapy notes" })

    expect(fields).toEqual({ sealedNameCiphertext: "Y3Q=", sealedNameEnvelope: { v: 1 } })
    expect(fields).not.toHaveProperty("displayName")
  })

  it("seeds the decrypt cache with the new name keyed by the fresh ciphertext (no re-decrypt flicker)", async () => {
    vi.spyOn(e2eSession, "getE2eSessionState").mockReturnValue(unlockedSession())
    vi.spyOn(streamKeyCache, "resolveCurrentStreamKey").mockResolvedValue({
      key: new Uint8Array(32),
      keyGeneration: 0,
    } as never)
    vi.spyOn(messageEnvelope, "sealStreamName").mockResolvedValue({
      ciphertext: "Y3Q=",
      envelope: { v: 1 } as never,
    })

    await sealStreamRename({ workspaceId: WS, streamId: STREAM, userId: USER, name: "Therapy notes" })

    // The cleartext we just sealed is immediately resolvable on this device,
    // keyed by the fresh ciphertext, so the overlay/header render the new name
    // the instant the stream row flips to it instead of decrypting our own write.
    expect(getCachedStreamName(streamNameCacheKey(WS, STREAM, "Y3Q="))).toBe("Therapy notes")
  })
})
