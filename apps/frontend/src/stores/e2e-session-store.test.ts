import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  enrollDeviceBiometric,
  enrollDevicePin,
  getDeviceUnlockMethod,
  getE2eSessionState,
  loadE2eKeyForUser,
  lock,
  requireUnlockedPrivateKey,
  resetE2eSessionStoreCache,
  rotatePassphrase,
  setDeviceTrust,
  setupNewKey,
  unlock,
  unlockWithPin,
  unlockWithWebAuthn,
} from "./e2e-session-store"
import { e2eKeysApi } from "@/api/e2e-keys"
import { DEFAULT_KDF_PARAMS } from "@/lib/crypto/passphrase"
import { MAX_PIN_ATTEMPTS } from "@/lib/crypto/pin-device-key"
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
  await Promise.all([db.e2eKeys.clear(), db.e2eDeviceKeys.clear()])
  vi.restoreAllMocks()
})

/** Simulate a page reload: drop in-memory state but keep IDB (device key + bundle). */
async function reload(): Promise<void> {
  resetE2eSessionStoreCache()
  await loadE2eKeyForUser(WORKSPACE_ID, USER_ID)
}

describe("e2e session store", () => {
  it("transitions to no-key when the server reports no active key", async () => {
    await loadE2eKeyForUser(WORKSPACE_ID, USER_ID)
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("no-key")
  })

  it("setupNewKey leaves the store unlocked with the matching keyId", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "correct-horse-battery-staple", { params: FAST_PARAMS })
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
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
    await lock(WORKSPACE_ID, USER_ID)
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("locked")
    expect(state.privateKey).toBeNull()
    expect(state.publicKey).not.toBeNull() // still known
    expect(() => requireUnlockedPrivateKey(WORKSPACE_ID, USER_ID)).toThrow(/locked/)
  })

  it("unlock with the correct passphrase restores the unwrapped private key", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "correct-passphrase", { params: FAST_PARAMS })
    await lock(WORKSPACE_ID, USER_ID)

    await unlock(WORKSPACE_ID, USER_ID, "correct-passphrase")
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("unlocked")
    expect(state.privateKey).not.toBeNull()
  })

  it("unlock with the wrong passphrase leaves the store locked and surfaces an error", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "right", { params: FAST_PARAMS })
    await lock(WORKSPACE_ID, USER_ID)

    await expect(unlock(WORKSPACE_ID, USER_ID, "wrong")).rejects.toThrow()
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("locked")
    expect(state.privateKey).toBeNull()
    expect(state.error).toBeTruthy()
  })

  it("rotatePassphrase replaces the wrapped bundle but keeps an unlocked session", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "old-pp", { params: FAST_PARAMS })
    const initialKeyId = serverKey?.keyId

    await rotatePassphrase(WORKSPACE_ID, USER_ID, "old-pp", "new-pp", FAST_PARAMS)
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("unlocked")
    expect(serverKey?.keyId).not.toBe(initialKeyId)
    expect(state.keyId).toBe(serverKey?.keyId)

    // Old passphrase should no longer unlock anything; new passphrase should.
    await lock(WORKSPACE_ID, USER_ID)
    await expect(unlock(WORKSPACE_ID, USER_ID, "old-pp")).rejects.toThrow()
    await unlock(WORKSPACE_ID, USER_ID, "new-pp")
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
  })

  it("resetE2eSessionStoreCache drops in-memory state for every scope", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
    resetE2eSessionStoreCache()
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("unknown")
    expect(state.privateKey).toBeNull()
  })

  it("loadE2eKeyForUser cannot clobber a concurrent setupNewKey's unlocked state", async () => {
    // Race: loadE2eKeyForUser starts while a setupNewKey is already in flight.
    // Make the server GET resolve *after* the setupNewKey landed so the load's
    // trailing setState would otherwise overwrite the unlocked status.
    let releaseGet: () => void = () => {}
    const getGate = new Promise<void>((resolve) => {
      releaseGet = resolve
    })
    vi.spyOn(e2eKeysApi, "get").mockImplementation(async () => {
      await getGate
      return serverKey
    })

    const loadPromise = loadE2eKeyForUser(WORKSPACE_ID, USER_ID)
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")

    releaseGet()
    await loadPromise

    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("unlocked")
    expect(state.privateKey).not.toBeNull()
    expect(state.keyId).toBe(serverKey?.keyId)
  })
})

describe("e2e session store — keep me unlocked on this device", () => {
  it("setupNewKey without trust does not persist a device key", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).deviceTrusted).toBe(false)
    expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeUndefined()

    await reload()
    // No device key → a reload must land back on the unlock prompt.
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("locked")
  })

  it("unlock with trustDevice persists the key and a reload resumes unlocked", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
    await lock(WORKSPACE_ID, USER_ID)
    const result = await unlock(WORKSPACE_ID, USER_ID, "pp", { trustDevice: true })
    expect(result).toEqual({ trustRequested: true, trustPersisted: true })

    const unlocked = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(unlocked.status).toBe("unlocked")
    expect(unlocked.deviceTrusted).toBe(true)
    expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeDefined()

    await reload()
    const restored = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(restored.status).toBe("unlocked")
    expect(restored.privateKey).not.toBeNull()
    expect(restored.deviceTrusted).toBe(true)
    // The restored key must actually work for decryption.
    expect(() => requireUnlockedPrivateKey(WORKSPACE_ID, USER_ID)).not.toThrow()
  })

  it("unlock survives a failed device-key persist: unlocked, untrusted, no error", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
    await lock(WORKSPACE_ID, USER_ID)

    // Simulate a browser that can't structured-clone a CryptoKey into IDB
    // (Firefox/private mode, quota, blocked DB) — the device-key write rejects.
    vi.spyOn(db.e2eDeviceKeys, "put").mockRejectedValueOnce(new Error("idb put failed"))

    const result = await unlock(WORKSPACE_ID, USER_ID, "pp", { trustDevice: true })

    // The passphrase was correct, so the session is unlocked for this run — a
    // persist failure must NOT be reported as a wrong-passphrase error.
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("unlocked")
    expect(state.privateKey).not.toBeNull()
    expect(state.error).toBeNull()
    // ...but the device was not actually kept unlocked.
    expect(state.deviceTrusted).toBe(false)
    expect(result).toEqual({ trustRequested: true, trustPersisted: false })
    expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeUndefined()
  })

  it("setupNewKey with trustDevice seals the key under a non-extractable AES device key", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS, trustDevice: true })
    const row = await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)
    expect(row).toBeDefined()
    // We must NOT persist the X25519 CryptoKey directly — some browsers drop it
    // on disk, which is the bug this design avoids. Store the sealed bytes plus
    // a non-extractable AES key instead. (The row type no longer carries a
    // `privateKey` field at all, so that regression can't recur.)
    expect(row!.deviceWrappedPrivate).toBeTruthy()
    const wrapKey = row!.deviceWrapKey!
    expect(wrapKey).toBeInstanceOf(CryptoKey)
    expect(wrapKey.algorithm.name).toBe("AES-GCM")
    expect(wrapKey.extractable).toBe(false)
    // The non-extractable AES key can never be read back out — so the IDB row
    // alone can't yield the raw private bytes.
    await expect(crypto.subtle.exportKey("raw", wrapKey)).rejects.toThrow()
  })

  it("lock forgets the device key so a reload requires the passphrase again", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS, trustDevice: true })
    expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeDefined()

    await lock(WORKSPACE_ID, USER_ID)
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).deviceTrusted).toBe(false)
    expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeUndefined()

    await reload()
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("locked")
  })

  it("a corrupt device key falls back to the passphrase prompt and is forgotten", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS, trustDevice: true })
    // Tamper with the sealed bytes so the AES-GCM unwrap fails on the next load.
    await db.e2eDeviceKeys.update(`${WORKSPACE_ID}:${USER_ID}`, { deviceWrappedPrivate: "not-valid-base64-ciphertext" })

    await reload()
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("locked")
    // The unreadable device key is dropped so it can't wedge future loads.
    expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeUndefined()
  })

  describe("device PIN quick-unlock", () => {
    const PIN = "135790"

    it("setup with a PIN resumes pin-locked, and the right PIN unlocks", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "pp-correct", { params: FAST_PARAMS, pin: PIN })
      expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
      // PIN mode stores the sealed bundle, not auto-resume device material.
      const row = await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)
      expect(row!.pinWrappedPrivate).toBeTruthy()
      expect(row!.deviceWrapKey).toBeUndefined()
      expect(row!.deviceWrappedPrivate).toBeUndefined()

      await reload()
      const locked = getE2eSessionState(WORKSPACE_ID, USER_ID)
      expect(locked.status).toBe("locked")
      expect(locked.pinProtected).toBe(true)

      await unlockWithPin(WORKSPACE_ID, USER_ID, PIN)
      expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
    })

    it("a wrong PIN keeps the session locked and counts the attempt", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS, pin: PIN })
      await reload()

      await expect(unlockWithPin(WORKSPACE_ID, USER_ID, "000000")).rejects.toThrow()
      const s = getE2eSessionState(WORKSPACE_ID, USER_ID)
      expect(s.status).toBe("locked")
      expect(s.pinProtected).toBe(true)
      const row = await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)
      expect(row!.pinFailedAttempts).toBe(1)

      // The correct PIN then unlocks and clears the counter.
      await unlockWithPin(WORKSPACE_ID, USER_ID, PIN)
      expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
      const after = await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)
      expect(after!.pinFailedAttempts).toBe(0)
    })

    it("rotating the passphrase clears a PIN device key instead of silently downgrading", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "old-passphrase", { params: FAST_PARAMS, pin: PIN })
      await rotatePassphrase(WORKSPACE_ID, USER_ID, "old-passphrase", "new-passphrase", FAST_PARAMS)

      // The PIN-gated device key is gone — not re-persisted as a plain auto-resume
      // key, which would have dropped the PIN gate.
      expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeUndefined()

      // A reload now requires the passphrase (no PIN, no auto-resume).
      await reload()
      const s = getE2eSessionState(WORKSPACE_ID, USER_ID)
      expect(s.status).toBe("locked")
      expect(s.pinProtected).toBeFalsy()
    })

    it("forgets the PIN after MAX_PIN_ATTEMPTS so only the passphrase recovers", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS, pin: PIN })
      await reload()

      for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
        await expect(unlockWithPin(WORKSPACE_ID, USER_ID, "000000")).rejects.toThrow()
      }

      // Device PIN material is gone; a reload no longer offers a PIN.
      expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeUndefined()
      const s = getE2eSessionState(WORKSPACE_ID, USER_ID)
      expect(s.status).toBe("locked")
      expect(s.pinProtected).toBe(false)
    })
  })

  describe("device biometric (WebAuthn PRF) quick-unlock", () => {
    // The ceremony (navigator.credentials) is covered by the Playwright
    // virtual-authenticator E2E; here the PRF secret is supplied directly.
    const SECRET = new Uint8Array(32).fill(7)
    const WEBAUTHN = { credentialId: "cred_test", prfSalt: "c2FsdHk=", prfSecret: SECRET }

    it("setup with biometric resumes webauthn-locked, and the secret unlocks", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "pp-correct", { params: FAST_PARAMS, webauthn: WEBAUTHN })
      expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
      const row = await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)
      expect(row!.webauthnWrappedPrivate).toBeTruthy()
      expect(row!.deviceWrapKey).toBeUndefined()
      expect(row!.deviceWrappedPrivate).toBeUndefined()

      await reload()
      const locked = getE2eSessionState(WORKSPACE_ID, USER_ID)
      expect(locked.status).toBe("locked")
      expect(locked.webauthnProtected).toBe(true)

      await unlockWithWebAuthn(WORKSPACE_ID, USER_ID, SECRET)
      expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
    })

    it("a wrong PRF secret keeps the session locked", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS, webauthn: WEBAUTHN })
      await reload()

      await expect(unlockWithWebAuthn(WORKSPACE_ID, USER_ID, new Uint8Array(32).fill(9))).rejects.toThrow()
      const s = getE2eSessionState(WORKSPACE_ID, USER_ID)
      expect(s.status).toBe("locked")
      expect(s.webauthnProtected).toBe(true)
    })
  })

  it("setDeviceTrust toggles persistence without re-entering the passphrase", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
    await setDeviceTrust(WORKSPACE_ID, USER_ID, true)
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).deviceTrusted).toBe(true)
    expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeDefined()

    await setDeviceTrust(WORKSPACE_ID, USER_ID, false)
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).deviceTrusted).toBe(false)
    expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeUndefined()
    // Still unlocked in-memory — only the device persistence changed.
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
  })

  it("setDeviceTrust(true) throws when the session is locked", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
    await lock(WORKSPACE_ID, USER_ID)
    await expect(setDeviceTrust(WORKSPACE_ID, USER_ID, true)).rejects.toThrow()
  })

  describe("post-setup quick-unlock enrollment", () => {
    const PIN = "246810"
    const PRF_SECRET = new Uint8Array(32).fill(5)
    const REGISTRATION = { credentialId: "cred_enroll", prfSalt: "c2FsdHk=", prfSecret: PRF_SECRET }

    it("reports the device unlock method as it changes", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
      expect(await getDeviceUnlockMethod(WORKSPACE_ID, USER_ID)).toBe("none")

      await setDeviceTrust(WORKSPACE_ID, USER_ID, true)
      expect(await getDeviceUnlockMethod(WORKSPACE_ID, USER_ID)).toBe("remembered")

      await enrollDevicePin(WORKSPACE_ID, USER_ID, PIN)
      expect(await getDeviceUnlockMethod(WORKSPACE_ID, USER_ID)).toBe("pin")

      // Switching back to plain auto-resume drops the PIN gate.
      await setDeviceTrust(WORKSPACE_ID, USER_ID, true)
      expect(await getDeviceUnlockMethod(WORKSPACE_ID, USER_ID)).toBe("remembered")
    })

    it("enrolls a PIN on an unlocked key, and a reload then needs that PIN", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
      await enrollDevicePin(WORKSPACE_ID, USER_ID, PIN)
      expect(getE2eSessionState(WORKSPACE_ID, USER_ID).deviceTrusted).toBe(true)

      await reload()
      const locked = getE2eSessionState(WORKSPACE_ID, USER_ID)
      expect(locked.status).toBe("locked")
      expect(locked.pinProtected).toBe(true)

      await unlockWithPin(WORKSPACE_ID, USER_ID, PIN)
      expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
    })

    it("enrolls biometrics on an unlocked key, and a reload then needs the PRF secret", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
      await enrollDeviceBiometric(WORKSPACE_ID, USER_ID, REGISTRATION)
      const row = await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)
      expect(row!.webauthnWrappedPrivate).toBeTruthy()
      expect(row!.pinWrappedPrivate).toBeUndefined()

      await reload()
      expect(getE2eSessionState(WORKSPACE_ID, USER_ID).webauthnProtected).toBe(true)

      await unlockWithWebAuthn(WORKSPACE_ID, USER_ID, PRF_SECRET)
      expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
    })

    it("replaces an existing method rather than stacking (PIN then biometric)", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
      await enrollDevicePin(WORKSPACE_ID, USER_ID, PIN)
      await enrollDeviceBiometric(WORKSPACE_ID, USER_ID, REGISTRATION)

      const row = await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)
      expect(row!.webauthnWrappedPrivate).toBeTruthy()
      expect(row!.pinWrappedPrivate).toBeUndefined()
      expect(await getDeviceUnlockMethod(WORKSPACE_ID, USER_ID)).toBe("biometric")
    })

    it("rejects a malformed PIN and enrolling while locked", async () => {
      await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS })
      await expect(enrollDevicePin(WORKSPACE_ID, USER_ID, "12")).rejects.toThrow()

      await lock(WORKSPACE_ID, USER_ID)
      await expect(enrollDevicePin(WORKSPACE_ID, USER_ID, PIN)).rejects.toThrow(/Unlock/)
      await expect(enrollDeviceBiometric(WORKSPACE_ID, USER_ID, REGISTRATION)).rejects.toThrow(/Unlock/)
    })
  })

  it("a server-side rotation discards the stale device key and relocks", async () => {
    // Trust this device, then simulate another device rotating the key: the
    // server now reports a different keyId than the one we persisted.
    await setupNewKey(WORKSPACE_ID, USER_ID, "pp", { params: FAST_PARAMS, trustDevice: true })
    serverKey = {
      keyId: "e2ek_rotated_elsewhere",
      publicKey: serverKey!.publicKey,
      encryptedPrivateBundle: serverKey!.encryptedPrivateBundle,
      kdfSalt: serverKey!.kdfSalt,
      kdfParams: serverKey!.kdfParams,
      createdAt: new Date().toISOString(),
    }

    await reload()
    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.status).toBe("locked")
    expect(state.deviceTrusted).toBe(false)
    expect(await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)).toBeUndefined()
  })

  it("rotatePassphrase on a trusted device re-persists under the new keyId", async () => {
    await setupNewKey(WORKSPACE_ID, USER_ID, "old-pp", { params: FAST_PARAMS, trustDevice: true })
    await rotatePassphrase(WORKSPACE_ID, USER_ID, "old-pp", "new-pp", FAST_PARAMS)

    const state = getE2eSessionState(WORKSPACE_ID, USER_ID)
    expect(state.deviceTrusted).toBe(true)
    const row = await db.e2eDeviceKeys.get(`${WORKSPACE_ID}:${USER_ID}`)
    expect(row?.keyId).toBe(state.keyId)

    // The re-persisted key survives a reload (no relock from a phantom rotation).
    await reload()
    expect(getE2eSessionState(WORKSPACE_ID, USER_ID).status).toBe("unlocked")
  })
})
