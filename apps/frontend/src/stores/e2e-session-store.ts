import { useSyncExternalStore } from "react"
import { e2eKeysApi } from "@/api/e2e-keys"
import { clearDecryptCache } from "@/lib/crypto/decrypt-cache"
import { clearStreamKeyCache } from "@/lib/crypto/stream-key-cache"
import { clearAttachmentRefCache } from "@/lib/crypto/attachment-crypto"
import { base64ToBytes, bytesToBase64 } from "@threa/crypto"
import { generateUIK, toNonExtractable, unwrapPrivate, wrapPrivate } from "@/lib/crypto/keys"
import {
  MAX_PIN_ATTEMPTS,
  unwrapPrivateKeyWithPin,
  wrapPrivateKeyWithPin,
  type PinWrappedKey,
} from "@/lib/crypto/pin-device-key"
import { unwrapPrivateKeyWithPrf, wrapPrivateKeyWithPrf } from "@/lib/crypto/webauthn-device-key"
import { DEFAULT_KDF_PARAMS, deriveKEK, generateSalt, type KdfParams } from "@/lib/crypto/passphrase"
import { db, type CachedE2eDeviceKey, type CachedE2eKey } from "@/db"

/**
 * In-memory session store for the user's unwrapped E2E identity key.
 *
 * The unwrapped private key never leaves this module: it's held as a
 * non-extractable `CryptoKey` for the life of the session and discarded on
 * lock / sign-out. The wrapped bundle (encrypted by the passphrase-derived
 * KEK) lives in IDB for offline unlock and on the server for cross-device
 * recovery; the bare private key never persists anywhere.
 *
 * The status machine:
 *   - `unknown`   — initial state before we've checked for a cached key
 *   - `no-key`    — no UIK on the server (or anywhere): show setup
 *   - `locked`    — bundle present, KEK not yet derived: show unlock
 *   - `unlocking` — derivation in flight (Argon2id can take ~250ms)
 *   - `unlocked`  — private key in memory, ready to encrypt/decrypt
 */
export type E2eSessionStatus = "unknown" | "no-key" | "locked" | "unlocking" | "unlocked"

export interface E2eSessionState {
  status: E2eSessionStatus
  /** The user's stable key id (e.g. `e2ek_XXX`) — present whenever a UIK exists. */
  keyId: string | null
  /** Raw 32-byte X25519 public key. Cached for self-encryption on the local device. */
  publicKey: Uint8Array | null
  /** The unwrapped private CryptoKey. Only set while `status === "unlocked"`. */
  privateKey: CryptoKey | null
  /**
   * `true` when this device holds a persisted ("keep me unlocked") private
   * key — i.e. a reload will resume `unlocked` without the passphrase. Mirrors
   * the presence of an `e2eDeviceKeys` row so the UI can render the toggle's
   * checked state reactively.
   */
  deviceTrusted: boolean
  /**
   * `true` when this device's trusted key is gated behind a PIN — a reload
   * resumes `locked` and the unlock surface should prompt for the PIN (with a
   * passphrase fallback) rather than the passphrase directly. Only meaningful
   * alongside `status: "locked"`; cleared once unlocked.
   */
  pinProtected?: boolean
  /**
   * `true` when this device's trusted key is gated behind a biometric (WebAuthn
   * PRF) — the unlock surface should offer the biometric prompt (with a
   * passphrase fallback). Only meaningful alongside `status: "locked"`.
   */
  webauthnProtected?: boolean
  /** Last error from a setup / unlock / rotate attempt. Cleared on the next action. */
  error: string | null
}

interface CachedKeyView {
  keyId: string
  publicKey: Uint8Array
  encryptedPrivateBundle: Uint8Array
  kdfSalt: Uint8Array
  kdfParams: KdfParams
}

/**
 * Outcome of an unlock/setup that may have been asked to "keep me unlocked".
 * `trustPersisted` is `false` when trust was requested but the device-key IDB
 * write failed — the session is still unlocked, the device just won't resume
 * unlocked next load. Lets the modal warn instead of falsely claiming success.
 */
export interface DeviceTrustResult {
  trustRequested: boolean
  trustPersisted: boolean
}

const INITIAL_STATE: E2eSessionState = {
  status: "unknown",
  keyId: null,
  publicKey: null,
  privateKey: null,
  deviceTrusted: false,
  error: null,
}

interface ScopeState {
  state: E2eSessionState
  cachedKey: CachedKeyView | null
  /**
   * Monotonic counter bumped at the start of every `loadE2eKeyForUser` call.
   * A stale server response (e.g. one whose request started before a
   * `setupNewKey` or `unlock` landed) must not overwrite the newer state —
   * compare against the snapshot taken at the start of the call.
   */
  loadGeneration: number
}

const scopes = new Map<string, ScopeState>()
const listeners = new Map<string, Set<() => void>>()

function scopeKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`
}

function getOrCreateScope(workspaceId: string, userId: string): ScopeState {
  const key = scopeKey(workspaceId, userId)
  let scope = scopes.get(key)
  if (!scope) {
    scope = { state: INITIAL_STATE, cachedKey: null, loadGeneration: 0 }
    scopes.set(key, scope)
  }
  return scope
}

function emit(workspaceId: string, userId: string): void {
  const set = listeners.get(scopeKey(workspaceId, userId))
  if (!set) return
  for (const listener of set) listener()
}

function setState(workspaceId: string, userId: string, patch: Partial<E2eSessionState>): void {
  const scope = getOrCreateScope(workspaceId, userId)
  scope.state = { ...scope.state, ...patch }
  emit(workspaceId, userId)
}

function toCachedKeyView(row: CachedE2eKey): CachedKeyView {
  return {
    keyId: row.keyId,
    publicKey: base64ToBytes(row.publicKey),
    encryptedPrivateBundle: base64ToBytes(row.encryptedPrivateBundle),
    kdfSalt: base64ToBytes(row.kdfSalt),
    kdfParams: row.kdfParams,
  }
}

async function writeCacheRow(
  workspaceId: string,
  userId: string,
  view: CachedKeyView,
  createdAt: string
): Promise<void> {
  const row: CachedE2eKey = {
    id: `${workspaceId}:${userId}`,
    workspaceId,
    userId,
    keyId: view.keyId,
    publicKey: bytesToBase64(view.publicKey),
    encryptedPrivateBundle: bytesToBase64(view.encryptedPrivateBundle),
    kdfSalt: bytesToBase64(view.kdfSalt),
    kdfParams: view.kdfParams,
    createdAt,
    _cachedAt: Date.now(),
  }
  await db.e2eKeys.put(row)
}

/** Read the "keep me unlocked" device key row, if this device is trusted. */
function readDeviceKey(workspaceId: string, userId: string): Promise<CachedE2eDeviceKey | undefined> {
  return db.e2eDeviceKeys.get(`${workspaceId}:${userId}`)
}

/**
 * Persist the unwrapped private key for "keep me unlocked on this device".
 * The key MUST already be non-extractable — we never write extractable key
 * material to disk. Callers holding an extractable key (fresh from setup)
 * convert it via `toNonExtractable` first.
 */
async function persistDeviceKey(
  workspaceId: string,
  userId: string,
  keyId: string,
  publicKey: Uint8Array,
  privateKey: CryptoKey
): Promise<void> {
  const row: CachedE2eDeviceKey = {
    id: `${workspaceId}:${userId}`,
    workspaceId,
    userId,
    keyId,
    publicKey: bytesToBase64(publicKey),
    privateKey,
    trustedAt: new Date().toISOString(),
  }
  await db.e2eDeviceKeys.put(row)
}

/**
 * Best-effort variant of `persistDeviceKey` that never throws. Returns `true`
 * when the key was written, `false` when the IDB put failed (e.g. private
 * browsing, quota, or a browser that won't structured-clone a non-extractable
 * CryptoKey). A failure here means "unlocked for this session but not kept
 * unlocked" — never a failed unlock — so callers must not surface it as a
 * wrong-passphrase error.
 */
async function tryPersistDeviceKey(
  workspaceId: string,
  userId: string,
  keyId: string,
  publicKey: Uint8Array,
  privateKey: CryptoKey
): Promise<boolean> {
  try {
    await persistDeviceKey(workspaceId, userId, keyId, publicKey, privateKey)
    return true
  } catch (err) {
    console.warn('[e2e] "keep me unlocked" persist failed; staying unlocked for this session only', err)
    return false
  }
}

/**
 * Persist a PIN-gated device key: the PIN-wrapped private bundle + salt/params,
 * with the attempt counter reset. No `privateKey` is stored, so a reload can't
 * auto-resume — `unlockWithPin` must run first. Best-effort like its sibling.
 */
async function tryPersistPinDeviceKey(
  workspaceId: string,
  userId: string,
  keyId: string,
  publicKey: Uint8Array,
  wrapped: PinWrappedKey
): Promise<boolean> {
  try {
    const row: CachedE2eDeviceKey = {
      id: `${workspaceId}:${userId}`,
      workspaceId,
      userId,
      keyId,
      publicKey: bytesToBase64(publicKey),
      pinWrappedPrivate: wrapped.pinWrappedPrivate,
      pinSalt: wrapped.pinSalt,
      pinKdfParams: wrapped.pinKdfParams,
      pinFailedAttempts: 0,
      trustedAt: new Date().toISOString(),
    }
    await db.e2eDeviceKeys.put(row)
    return true
  } catch (err) {
    console.warn("[e2e] device PIN persist failed; staying unlocked for this session only", err)
    return false
  }
}

/**
 * Persist a biometric (WebAuthn PRF) device key: the PRF-wrapped private bundle
 * + the credential id and PRF salt needed to re-derive the secret. No
 * `privateKey` is stored, so a reload requires a biometric assertion
 * (`unlockWithWebAuthn`). Best-effort like its siblings.
 */
async function tryPersistWebAuthnDeviceKey(
  workspaceId: string,
  userId: string,
  keyId: string,
  publicKey: Uint8Array,
  webauthn: { credentialId: string; prfSalt: string; wrappedPrivate: string }
): Promise<boolean> {
  try {
    const row: CachedE2eDeviceKey = {
      id: `${workspaceId}:${userId}`,
      workspaceId,
      userId,
      keyId,
      publicKey: bytesToBase64(publicKey),
      webauthnCredentialId: webauthn.credentialId,
      webauthnPrfSalt: webauthn.prfSalt,
      webauthnWrappedPrivate: webauthn.wrappedPrivate,
      trustedAt: new Date().toISOString(),
    }
    await db.e2eDeviceKeys.put(row)
    return true
  } catch (err) {
    console.warn("[e2e] device biometric persist failed; staying unlocked for this session only", err)
    return false
  }
}

/** Forget this device's trusted key (explicit lock, rotation mismatch, sign-out). */
function deleteDeviceKey(workspaceId: string, userId: string): Promise<void> {
  return db.e2eDeviceKeys.delete(`${workspaceId}:${userId}`)
}

/**
 * Hydrate the store for a workspace+user. Reads any locally cached bundle
 * from IDB first (so the unlock modal can render immediately), then fetches
 * the server's authoritative copy and reconciles. Idempotent — safe to call
 * on every mount.
 */
export async function loadE2eKeyForUser(workspaceId: string, userId: string): Promise<void> {
  const scope = getOrCreateScope(workspaceId, userId)
  const generation = ++scope.loadGeneration

  // Already unlocked — bootstrap is a no-op once we're holding the key.
  if (scope.state.status === "unlocked") return

  // "Keep me unlocked on this device": if a persisted private key exists, jump
  // straight to `unlocked` (no passphrase, no Argon2id). The stored key is
  // non-extractable, so even reading it from IDB doesn't leak raw bytes.
  const [deviceKey, cachedRow] = await Promise.all([
    readDeviceKey(workspaceId, userId),
    db.e2eKeys.get(`${workspaceId}:${userId}`),
  ])
  if (scope.loadGeneration !== generation) return
  if (cachedRow) {
    scope.cachedKey = toCachedKeyView(cachedRow)
  }
  if (deviceKey?.privateKey) {
    setState(workspaceId, userId, {
      status: "unlocked",
      keyId: deviceKey.keyId,
      publicKey: base64ToBytes(deviceKey.publicKey),
      privateKey: deviceKey.privateKey,
      deviceTrusted: true,
      pinProtected: false,
      error: null,
    })
  } else if (deviceKey?.pinWrappedPrivate) {
    // PIN-gated: the key is here but sealed under the PIN, so resume `locked`
    // and flag `pinProtected` so the unlock surface prompts for the PIN.
    setState(workspaceId, userId, {
      status: "locked",
      keyId: deviceKey.keyId,
      publicKey: base64ToBytes(deviceKey.publicKey),
      deviceTrusted: false,
      pinProtected: true,
      error: null,
    })
  } else if (deviceKey?.webauthnWrappedPrivate) {
    // Biometric-gated: sealed under the authenticator's PRF secret; resume
    // `locked` and flag `webauthnProtected` so the surface offers the biometric.
    setState(workspaceId, userId, {
      status: "locked",
      keyId: deviceKey.keyId,
      publicKey: base64ToBytes(deviceKey.publicKey),
      deviceTrusted: false,
      webauthnProtected: true,
      error: null,
    })
  } else if (cachedRow) {
    setState(workspaceId, userId, {
      status: "locked",
      keyId: scope.cachedKey!.keyId,
      publicKey: scope.cachedKey!.publicKey,
      deviceTrusted: false,
      error: null,
    })
  }

  let server: Awaited<ReturnType<typeof e2eKeysApi.get>>
  try {
    server = await e2eKeysApi.get(workspaceId)
  } catch {
    // Offline or transient — keep what IDB gave us (including a restored
    // unlocked session). If IDB was also empty the scope stays in `unknown`,
    // which the UI treats as "still loading".
    return
  }

  // A newer `setupNewKey`, `unlock`, `rotatePassphrase`, or `revokeKey` may
  // have landed while the GET was in flight. Drop the now-stale response so
  // it can't clobber the fresher state.
  if (scope.loadGeneration !== generation) return

  if (!server) {
    // Server says no key, but if a concurrent local setupNewKey just produced
    // one we'd be lying. The generation check above already covers that — by
    // the time we get here, this response is the freshest signal.
    scope.cachedKey = null
    await Promise.all([db.e2eKeys.delete(`${workspaceId}:${userId}`), deleteDeviceKey(workspaceId, userId)])
    setState(workspaceId, userId, {
      status: "no-key",
      keyId: null,
      publicKey: null,
      privateKey: null,
      deviceTrusted: false,
      error: null,
    })
    return
  }

  const view: CachedKeyView = {
    keyId: server.keyId,
    publicKey: base64ToBytes(server.publicKey),
    encryptedPrivateBundle: base64ToBytes(server.encryptedPrivateBundle),
    kdfSalt: base64ToBytes(server.kdfSalt),
    kdfParams: server.kdfParams,
  }
  await writeCacheRow(workspaceId, userId, view, server.createdAt)
  // Re-check after the IDB write: a concurrent setupNewKey / unlock that fired
  // during that await may already have set status:"unlocked"; we must not
  // overwrite that fresher state below.
  if (scope.loadGeneration !== generation) return
  scope.cachedKey = view

  // Server may have rotated the key on another device. The persisted device
  // key (and any in-memory private key) no longer matches the new wrapped
  // bundle, so discard it and fall back to `locked` — the user re-enters the
  // passphrase once to re-establish trust.
  const rotatedAway = scope.state.keyId !== null && scope.state.keyId !== view.keyId
  if (rotatedAway) {
    await deleteDeviceKey(workspaceId, userId)
    if (scope.loadGeneration !== generation) return
    setState(workspaceId, userId, {
      status: "locked",
      keyId: view.keyId,
      publicKey: view.publicKey,
      privateKey: null,
      deviceTrusted: false,
      error: null,
    })
    return
  }

  // keyId matches. Preserve a restored `unlocked` session; otherwise present
  // the unlock prompt. Read the status fresh: a concurrent `unlock` /
  // `setupNewKey` can have flipped it to `unlocked` during the awaits above,
  // which TS's control-flow analysis can't see through the early return.
  const live = getE2eSessionState(workspaceId, userId)
  if (live.status === "unlocked") {
    setState(workspaceId, userId, { keyId: view.keyId, publicKey: view.publicKey, error: null })
    return
  }
  setState(workspaceId, userId, {
    status: "locked",
    keyId: view.keyId,
    publicKey: view.publicKey,
    privateKey: null,
    deviceTrusted: live.deviceTrusted,
    error: null,
  })
}

/**
 * First-time setup: generates a fresh UIK, wraps the private half with the
 * passphrase-derived KEK, persists to server + IDB, and leaves the store in
 * the `unlocked` state holding the live private CryptoKey.
 */
export async function setupNewKey(
  workspaceId: string,
  userId: string,
  passphrase: string,
  opts?: {
    params?: KdfParams
    trustDevice?: boolean
    pin?: string
    webauthn?: { credentialId: string; prfSalt: string; prfSecret: Uint8Array }
  }
): Promise<DeviceTrustResult | undefined> {
  const params = opts?.params ?? DEFAULT_KDF_PARAMS
  const scope = getOrCreateScope(workspaceId, userId)
  // Bump + snapshot. The bump invalidates any in-flight loadE2eKeyForUser; the
  // snapshot lets us detect a *later* writer that bumped past us so we don't
  // clobber their state when our slow awaits finally resolve.
  const generation = ++scope.loadGeneration
  setState(workspaceId, userId, { error: null })

  const salt = generateSalt()
  const kek = await deriveKEK(passphrase, salt, params)
  const uik = await generateUIK()
  const wrapped = await wrapPrivate(uik.privateKey, kek)

  const { key: serverKey } = await e2eKeysApi.set(workspaceId, {
    publicKey: bytesToBase64(uik.publicKey),
    encryptedPrivateBundle: bytesToBase64(wrapped),
    kdfSalt: bytesToBase64(salt),
    kdfParams: params,
  })
  if (scope.loadGeneration !== generation) return

  const view: CachedKeyView = {
    keyId: serverKey.keyId,
    publicKey: base64ToBytes(serverKey.publicKey),
    encryptedPrivateBundle: base64ToBytes(serverKey.encryptedPrivateBundle),
    kdfSalt: base64ToBytes(serverKey.kdfSalt),
    kdfParams: serverKey.kdfParams,
  }
  await writeCacheRow(workspaceId, userId, view, serverKey.createdAt)
  if (scope.loadGeneration !== generation) return

  const trustDevice = opts?.trustDevice ?? false
  const pin = opts?.pin
  const webauthn = opts?.webauthn
  let trustPersisted = false
  if (webauthn) {
    // Biometric quick-unlock: seal the (extractable) fresh key under the
    // authenticator's PRF secret. A reload requires a biometric assertion.
    const wrappedPrivate = await wrapPrivateKeyWithPrf(uik.privateKey, webauthn.prfSecret)
    trustPersisted = await tryPersistWebAuthnDeviceKey(workspaceId, userId, view.keyId, view.publicKey, {
      credentialId: webauthn.credentialId,
      prfSalt: webauthn.prfSalt,
      wrappedPrivate,
    })
    if (scope.loadGeneration !== generation) return
  } else if (pin) {
    // PIN quick-unlock: seal the (extractable) fresh key under the PIN-derived
    // KEK and store the bundle — a reload will require the PIN, not auto-resume.
    const wrapped = await wrapPrivateKeyWithPin(uik.privateKey, pin)
    trustPersisted = await tryPersistPinDeviceKey(workspaceId, userId, view.keyId, view.publicKey, wrapped)
    if (scope.loadGeneration !== generation) return
  } else if (trustDevice) {
    // The freshly generated key is extractable; persist the hardened
    // non-extractable form so the raw bytes never touch disk. Best-effort: a
    // failed device-key write must not fail setup — the key is already on the
    // server and cached, the user is just not kept unlocked on this device.
    const hardened = await toNonExtractable(uik.privateKey)
    trustPersisted = await tryPersistDeviceKey(workspaceId, userId, view.keyId, view.publicKey, hardened)
    if (scope.loadGeneration !== generation) return
  }
  scope.cachedKey = view
  setState(workspaceId, userId, {
    status: "unlocked",
    keyId: view.keyId,
    publicKey: view.publicKey,
    privateKey: uik.privateKey,
    deviceTrusted: trustPersisted,
    pinProtected: false,
    webauthnProtected: false,
    error: null,
  })
  return { trustRequested: trustDevice || !!pin || !!webauthn, trustPersisted }
}

/**
 * Derive the KEK from the passphrase and unwrap the cached private bundle.
 * Throws with a readable message on wrong-passphrase / tampered-bundle so
 * the modal can render an inline error.
 */
export async function unlock(
  workspaceId: string,
  userId: string,
  passphrase: string,
  opts?: {
    trustDevice?: boolean
    pin?: string
    webauthn?: { credentialId: string; prfSalt: string; prfSecret: Uint8Array }
  }
): Promise<DeviceTrustResult | undefined> {
  const scope = getOrCreateScope(workspaceId, userId)
  const cached = scope.cachedKey
  if (!cached) {
    throw new Error("No wrapped key available to unlock")
  }
  const trustDevice = opts?.trustDevice ?? false
  const pin = opts?.pin
  const webauthn = opts?.webauthn
  const generation = ++scope.loadGeneration
  setState(workspaceId, userId, { status: "unlocking", error: null })

  let privateKey: CryptoKey
  try {
    const kek = await deriveKEK(passphrase, cached.kdfSalt, cached.kdfParams)
    // Non-extractable by default — the session never needs the raw bytes back.
    // Setting a device PIN or biometric is the exception: it must re-seal the
    // private key under the new KEK, which requires an extractable key to export.
    privateKey = await unwrapPrivate(cached.encryptedPrivateBundle, kek, { extractable: !!pin || !!webauthn })
  } catch (err) {
    // Only a derive/unwrap failure is the wrong-passphrase (or tampered-bundle)
    // case — the one condition the modal surfaces as "try again". Failures in
    // the device-trust persist below must NOT land here.
    if (scope.loadGeneration === generation) {
      const message = err instanceof Error ? err.message : "Failed to unlock encrypted scratchpads"
      setState(workspaceId, userId, { status: "locked", error: message, privateKey: null })
    }
    throw err
  }

  if (scope.loadGeneration !== generation) return

  // Passphrase verified — the session is unlocked regardless of what the
  // device-trust write does. Persisting (or clearing) trust is best-effort: a
  // failed IDB write means "not kept unlocked", never a failed unlock.
  let trustPersisted = false
  if (webauthn) {
    // Re-seal under the authenticator's PRF secret: a reload requires biometric.
    const wrappedPrivate = await wrapPrivateKeyWithPrf(privateKey, webauthn.prfSecret)
    trustPersisted = await tryPersistWebAuthnDeviceKey(workspaceId, userId, cached.keyId, cached.publicKey, {
      credentialId: webauthn.credentialId,
      prfSalt: webauthn.prfSalt,
      wrappedPrivate,
    })
  } else if (pin) {
    // Re-seal under the PIN: a reload will require the PIN, not auto-resume.
    const wrapped = await wrapPrivateKeyWithPin(privateKey, pin)
    trustPersisted = await tryPersistPinDeviceKey(workspaceId, userId, cached.keyId, cached.publicKey, wrapped)
  } else if (trustDevice) {
    trustPersisted = await tryPersistDeviceKey(workspaceId, userId, cached.keyId, cached.publicKey, privateKey)
  } else {
    // Honour an explicit "don't keep me unlocked": drop any prior trust (incl. a PIN).
    try {
      await deleteDeviceKey(workspaceId, userId)
    } catch (err) {
      console.warn("[e2e] failed to clear device trust on unlock", err)
    }
  }
  if (scope.loadGeneration !== generation) return

  setState(workspaceId, userId, {
    status: "unlocked",
    keyId: cached.keyId,
    publicKey: cached.publicKey,
    privateKey,
    deviceTrusted: trustPersisted,
    pinProtected: false,
    webauthnProtected: false,
    error: null,
  })
  return { trustRequested: trustDevice || !!pin || !!webauthn, trustPersisted }
}

/**
 * Resume an unlocked session from this device's PIN-gated key. Reads the
 * PIN-wrapped bundle, derives the KEK from the PIN, and unwraps. On the wrong
 * PIN it counts the failure and, once `MAX_PIN_ATTEMPTS` is hit, forgets the
 * device PIN entirely (dropping back to passphrase-only) so a stolen device
 * can't be brute-forced offline. Throws on any failure so the modal can render
 * an inline error; the error message is also set on the session state.
 */
export async function unlockWithPin(workspaceId: string, userId: string, pin: string): Promise<void> {
  const scope = getOrCreateScope(workspaceId, userId)
  const row = await readDeviceKey(workspaceId, userId)
  if (!row?.pinWrappedPrivate || !row.pinSalt || !row.pinKdfParams) {
    throw new Error("No device PIN is set")
  }
  const wrapped: PinWrappedKey = {
    pinWrappedPrivate: row.pinWrappedPrivate,
    pinSalt: row.pinSalt,
    pinKdfParams: row.pinKdfParams,
  }
  const generation = ++scope.loadGeneration
  setState(workspaceId, userId, { status: "unlocking", error: null })

  let privateKey: CryptoKey
  try {
    privateKey = await unwrapPrivateKeyWithPin(wrapped, pin)
  } catch (err) {
    const attempts = (row.pinFailedAttempts ?? 0) + 1
    if (attempts >= MAX_PIN_ATTEMPTS) {
      // Lockout: forget the PIN material so only the passphrase can recover.
      await deleteDeviceKey(workspaceId, userId).catch(() => {})
      if (scope.loadGeneration === generation) {
        setState(workspaceId, userId, {
          status: "locked",
          pinProtected: false,
          privateKey: null,
          error: "Too many PIN attempts — unlock with your passphrase.",
        })
      }
    } else {
      await db.e2eDeviceKeys.update(`${workspaceId}:${userId}`, { pinFailedAttempts: attempts }).catch(() => {})
      if (scope.loadGeneration === generation) {
        const left = MAX_PIN_ATTEMPTS - attempts
        setState(workspaceId, userId, {
          status: "locked",
          pinProtected: true,
          privateKey: null,
          error: `Incorrect PIN — ${left} attempt${left === 1 ? "" : "s"} left.`,
        })
      }
    }
    throw err instanceof Error ? err : new Error("Incorrect PIN")
  }

  if (scope.loadGeneration !== generation) return

  // Success — clear the failed-attempt counter.
  await db.e2eDeviceKeys.update(`${workspaceId}:${userId}`, { pinFailedAttempts: 0 }).catch(() => {})
  setState(workspaceId, userId, {
    status: "unlocked",
    keyId: row.keyId,
    publicKey: base64ToBytes(row.publicKey),
    privateKey,
    deviceTrusted: true,
    pinProtected: false,
    error: null,
  })
}

/**
 * Resume an unlocked session from this device's biometric (WebAuthn PRF) key.
 * The caller runs the biometric assertion (`getPrfSecret`) and passes the PRF
 * secret here; we unwrap the stored bundle with it. No app-side attempt counter
 * — the authenticator gates biometric attempts itself; a failure here means a
 * bad/foreign secret, surfaced inline with a passphrase fallback. Throws on
 * failure so the modal can react.
 */
export async function unlockWithWebAuthn(workspaceId: string, userId: string, prfSecret: Uint8Array): Promise<void> {
  const scope = getOrCreateScope(workspaceId, userId)
  const row = await readDeviceKey(workspaceId, userId)
  if (!row?.webauthnWrappedPrivate) {
    throw new Error("No biometric unlock is set")
  }
  const generation = ++scope.loadGeneration
  setState(workspaceId, userId, { status: "unlocking", error: null })

  let privateKey: CryptoKey
  try {
    privateKey = await unwrapPrivateKeyWithPrf(row.webauthnWrappedPrivate, prfSecret)
  } catch (err) {
    if (scope.loadGeneration === generation) {
      setState(workspaceId, userId, {
        status: "locked",
        webauthnProtected: true,
        privateKey: null,
        error: "Biometric unlock failed — try again or use your passphrase.",
      })
    }
    throw err instanceof Error ? err : new Error("Biometric unlock failed")
  }

  if (scope.loadGeneration !== generation) return

  setState(workspaceId, userId, {
    status: "unlocked",
    keyId: row.keyId,
    publicKey: base64ToBytes(row.publicKey),
    privateKey,
    deviceTrusted: true,
    webauthnProtected: false,
    error: null,
  })
}

/**
 * Rotate the passphrase: unwrap with the old one, re-wrap the *same* UIK
 * under a freshly-derived KEK, and replace the server bundle. The server
 * mints a fresh `keyId` for the new row, but the underlying X25519 key
 * material is identical — so envelopes addressed by the old `keyId` won't
 * match the new view's `recipientKeyId`, even though the private key still
 * decrypts them. Re-keying past envelopes is a separate (later) migration.
 */
export async function rotatePassphrase(
  workspaceId: string,
  userId: string,
  oldPassphrase: string,
  newPassphrase: string,
  params: KdfParams = DEFAULT_KDF_PARAMS
): Promise<void> {
  const scope = getOrCreateScope(workspaceId, userId)
  const cached = scope.cachedKey
  if (!cached) throw new Error("No wrapped key available to rotate")
  const wasTrusted = scope.state.deviceTrusted
  const generation = ++scope.loadGeneration

  const oldKek = await deriveKEK(oldPassphrase, cached.kdfSalt, cached.kdfParams)
  // Extractable: rotation re-exports the raw bytes to re-wrap under the new KEK.
  const privateKey = await unwrapPrivate(cached.encryptedPrivateBundle, oldKek, { extractable: true })

  const newSalt = generateSalt()
  const newKek = await deriveKEK(newPassphrase, newSalt, params)
  const wrapped = await wrapPrivate(privateKey, newKek)

  const { key: serverKey } = await e2eKeysApi.set(workspaceId, {
    publicKey: bytesToBase64(cached.publicKey),
    encryptedPrivateBundle: bytesToBase64(wrapped),
    kdfSalt: bytesToBase64(newSalt),
    kdfParams: params,
  })
  if (scope.loadGeneration !== generation) return

  const view: CachedKeyView = {
    keyId: serverKey.keyId,
    publicKey: base64ToBytes(serverKey.publicKey),
    encryptedPrivateBundle: base64ToBytes(serverKey.encryptedPrivateBundle),
    kdfSalt: base64ToBytes(serverKey.kdfSalt),
    kdfParams: serverKey.kdfParams,
  }
  await writeCacheRow(workspaceId, userId, view, serverKey.createdAt)
  if (scope.loadGeneration !== generation) return

  // Rotation mints a fresh keyId. If this device was trusted, re-persist the
  // device key under the new keyId (as non-extractable) so the next reload
  // still resumes unlocked instead of being treated as a stale rotation.
  // Best-effort: a failed re-persist just drops trust, it doesn't fail rotate.
  let trustPersisted = false
  if (wasTrusted) {
    const hardened = await toNonExtractable(privateKey)
    trustPersisted = await tryPersistDeviceKey(workspaceId, userId, view.keyId, view.publicKey, hardened)
    if (scope.loadGeneration !== generation) return
  }
  scope.cachedKey = view
  setState(workspaceId, userId, {
    status: "unlocked",
    keyId: view.keyId,
    publicKey: view.publicKey,
    privateKey,
    deviceTrusted: trustPersisted,
    error: null,
  })
}

/**
 * Revoke the active key on the server and reset local state to `no-key`.
 * Lives in the store (not the component) so the component layer stays
 * UI-focused (INV-15) and the lock + cache-clear ordering is consistent
 * across callers.
 */
export async function revokeKeyForUser(workspaceId: string, userId: string): Promise<void> {
  const scope = getOrCreateScope(workspaceId, userId)
  const generation = ++scope.loadGeneration
  await e2eKeysApi.revoke(workspaceId)
  if (scope.loadGeneration !== generation) return
  await Promise.all([db.e2eKeys.delete(`${workspaceId}:${userId}`), deleteDeviceKey(workspaceId, userId)])
  if (scope.loadGeneration !== generation) return
  scope.cachedKey = null
  setState(workspaceId, userId, {
    status: "no-key",
    keyId: null,
    publicKey: null,
    privateKey: null,
    deviceTrusted: false,
    error: null,
  })
}

/**
 * Drop the unwrapped private key from memory and forget this device's trust.
 * An explicit lock is a "stop keeping me unlocked" signal, so the persisted
 * device key is deleted — the next reload presents the unlock prompt. The
 * wrapped bundle stays cached in IDB so that unlock doesn't round-trip the
 * server.
 */
export async function lock(workspaceId: string, userId: string): Promise<void> {
  const scope = getOrCreateScope(workspaceId, userId)
  // Drop every decrypted payload from memory — Phase 3.5 keeps ciphertext at
  // rest in IDB and decrypts at render time, so the in-memory cache is the
  // only surface holding plaintext for this session.
  clearDecryptCache()
  clearStreamKeyCache()
  clearAttachmentRefCache()
  // Bump the generation so a concurrent loadE2eKeyForUser can't restore the
  // device key we're about to delete back into an unlocked state.
  scope.loadGeneration++
  if (!scope.cachedKey) {
    setState(workspaceId, userId, INITIAL_STATE)
  } else {
    setState(workspaceId, userId, {
      status: "locked",
      keyId: scope.cachedKey.keyId,
      publicKey: scope.cachedKey.publicKey,
      privateKey: null,
      deviceTrusted: false,
      error: null,
    })
  }
  await deleteDeviceKey(workspaceId, userId)
}

/**
 * Toggle "keep me unlocked on this device" from settings without re-entering
 * the passphrase. Enabling persists the current (already unwrapped) private
 * key as a non-extractable device key; disabling forgets it. Only meaningful
 * while `unlocked`.
 */
export async function setDeviceTrust(workspaceId: string, userId: string, trust: boolean): Promise<void> {
  const scope = getOrCreateScope(workspaceId, userId)
  const { status, privateKey, keyId, publicKey } = scope.state
  if (trust) {
    if (status !== "unlocked" || !privateKey || !keyId || !publicKey) {
      throw new Error("Unlock encrypted scratchpads before trusting this device")
    }
    // The in-memory key may be extractable (e.g. right after setup); harden it.
    await persistDeviceKey(workspaceId, userId, keyId, publicKey, await toNonExtractable(privateKey))
    setState(workspaceId, userId, { deviceTrusted: true })
    return
  }
  await deleteDeviceKey(workspaceId, userId)
  setState(workspaceId, userId, { deviceTrusted: false })
}

/**
 * Returns the in-memory CryptoKey for the active scope, or throws if the
 * user is locked / has no key set up. Callers needing to decrypt MUST check
 * `useE2eSessionStatus` first and route the user through the unlock modal
 * before reaching this.
 */
export function requireUnlockedPrivateKey(workspaceId: string, userId: string): CryptoKey {
  const scope = scopes.get(scopeKey(workspaceId, userId))
  if (!scope || scope.state.status !== "unlocked" || !scope.state.privateKey) {
    throw new Error("E2E session is locked")
  }
  return scope.state.privateKey
}

/** Pure getter for tests and imperative callers. */
export function getE2eSessionState(workspaceId: string, userId: string): E2eSessionState {
  return scopes.get(scopeKey(workspaceId, userId))?.state ?? INITIAL_STATE
}

function subscribe(workspaceId: string, userId: string, listener: () => void): () => void {
  const key = scopeKey(workspaceId, userId)
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(key)
  }
}

/**
 * React hook returning the current session state for the given scope. Use
 * destructured fields (`status`, `keyId`, etc.) — the object reference is
 * stable between emissions so React's shallow comparison still triggers
 * re-renders on field changes.
 */
export function useE2eSession(workspaceId: string, userId: string): E2eSessionState {
  return useSyncExternalStore(
    (listener) => subscribe(workspaceId, userId, listener),
    () => getE2eSessionState(workspaceId, userId),
    () => INITIAL_STATE
  )
}

/**
 * Cross-account safety: drop every in-memory private key and clear listeners
 * so an account switch can't leak account A's unwrapped key into account B's
 * subtree. The IDB rows survive because they're per-DB-instance — distinct
 * Dexie databases per account already isolate them.
 */
export function resetE2eSessionStoreCache(): void {
  scopes.clear()
  listeners.clear()
  clearDecryptCache()
  clearStreamKeyCache()
  clearAttachmentRefCache()
}
