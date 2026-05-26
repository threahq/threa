import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getE2eSessionState,
  loadE2eKeyForUser,
  lock,
  requireUnlockedPrivateKey,
  resetE2eSessionStoreCache,
  rotatePassphrase,
  setupNewKey,
  unlock,
} from "./e2e-session-store"
import { e2eKeysApi } from "@/api/e2e-keys"
import { DEFAULT_KDF_PARAMS } from "@/lib/crypto/passphrase"
import { db } from "@/db"

// Real Argon2id on default params would take ~250ms per derivation, which
// adds up across rotate/unlock cases. Match the fast preset the crypto tests
// use so the suite stays under a couple of seconds.
const FAST_PARAMS = { ...DEFAULT_KDF_PARAMS, m: 8 * 1024, t: 1 }

const WORKSPACE_ID = "ws_test"
const USER_ID = "usr_test"

interface InMemoryServerKey {
  keyId: string
  publicKey: string
  encryptedPrivateBundle: string
  kdfSalt: string
  kdfParams: typeof FAST_PARAMS
  createdAt: string
}

// Simulates the backend's single-active-key invariant: each `set` mints a
// fresh keyId and replaces the active key.
let serverKey: InMemoryServerKey | null = null
let keyCounter = 0

beforeEach(() => {
  serverKey = null
  keyCounter = 0
  vi.spyOn(e2eKeysApi, "get").mockImplementation(async () => serverKey)
  vi.spyOn(e2eKeysApi, "set").mockImplementation(async (_ws, input) => {
    const rotated = serverKey !== null
    serverKey = {
      keyId: `e2ek_test_${++keyCounter}`,
      publicKey: input.publicKey,
      encryptedPrivateBundle: input.encryptedPrivateBundle,
      kdfSalt: input.kdfSalt,
      kdfParams: input.kdfParams,
      createdAt: new Date().toISOString(),
    }
    return { key: serverKey, rotated }
  })
  vi.spyOn(e2eKeysApi, "revoke").mockImplementation(async () => {
    serverKey = null
  })
})

afterEach(async () => {
  resetE2eSessionStoreCache()
  await db.e2eKeys.clear()
  vi.restoreAllMocks()
})

describe("e2e session store", () => {
  it("transitions to no-key when the server reports no active key", async () => {
    await loadE2eKeyForUser(WORKSPACE_ID, USER_ID)
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("no-key")
  })

  it("setupNewKey leaves the store unlocked with the matching keyId", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "correct-horse-battery-staple", FAST_PARAMS)
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("unlocked")
    expect(state.keyId).toBe(serverKey?.keyId)
    expect(state.privateKey).not.toBeNull()
    expect(state.publicKey).not.toBeNull()

    // The wrapped bundle should also have been mirrored into IDB so a refresh
    // can unlock offline.
    const cached = await db.e2eKeys.get(`${WORKSPACE_ID}:${USER_ID}`)
    expect(cached?.keyId).toBe(serverKey?.keyId)
  })

  it("lock drops the in-memory private key but keeps the wrapped bundle cached", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", FAST_PARAMS)
    lock(WORKSPACE_ID, USER_ID)
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("locked")
    expect(state.privateKey).toBeNull()
    expect(state.publicKey).not.toBeNull() // still known
    expect(() => requireUnlockedPrivateKey(WORKSPACE_ID, USER_ID)).toThrow(/locked/)
  })

  it("unlock with the correct passphrase restores the unwrapped private key", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "correct-passphrase", FAST_PARAMS)
    lock(WORKSPACE_ID, USER_ID)

    await unlock(WORKSPACE_ID, USER_ID, "correct-passphrase")
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("unlocked")
    expect(state.privateKey).not.toBeNull()
  })

  it("unlock with the wrong passphrase leaves the store locked and surfaces an error", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "right", FAST_PARAMS)
    lock(WORKSPACE_ID, USER_ID)

    await expect(unlock(WORKSPACE_ID, USER_ID, "wrong")).rejects.toThrow()
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("locked")
    expect(state.privateKey).toBeNull()
    expect(state.error).toBeTruthy()
  })

  it("rotatePassphrase replaces the wrapped bundle but keeps an unlocked session", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "old-pp", FAST_PARAMS)
    const initialKeyId = serverKey?.keyId

    await rotatePassphrase(WORKSPACE_ID, USER_ID, "old-pp", "new-pp", FAST_PARAMS)
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("unlocked")
    expect(serverKey?.keyId).not.toBe(initialKeyId)
    expect(state.keyId).toBe(serverKey?.keyId)

    // Old passphrase should no longer unlock anything; new passphrase should.
    lock(WORKSPACE_ID, USER_ID)
    await expect(unlock(WORKSPACE_ID, USER_ID, "old-pp")).rejects.toThrow()
    await unlock(WORKSPACE_ID, USER_ID, "new-pp")
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
  })

  it("resetE2eSessionStoreCache drops in-memory state for every scope", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", FAST_PARAMS)
    resetE2eSessionStoreCache()
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("unknown")
    expect(state.privateKey).toBeNull()
  })
})
