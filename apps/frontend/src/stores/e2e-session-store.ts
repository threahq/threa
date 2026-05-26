import { useSyncExternalStore } from "react"
import { e2eKeysApi } from "@/api/e2e-keys"
import { base64ToBytes, bytesToBase64 } from "@/lib/crypto/encoding"
import { decryptPayloadAsString, encryptPayload } from "@/lib/crypto/envelope"
import { generateUIK, unwrapPrivate, wrapPrivate } from "@/lib/crypto/keys"
import { DEFAULT_KDF_PARAMS, deriveKEK, generateSalt, type KdfParams } from "@/lib/crypto/passphrase"
import { db, type CachedE2eKey } from "@/db"

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

const INITIAL_STATE: E2eSessionState = {
  status: "unknown",
  keyId: null,
  publicKey: null,
  privateKey: null,
  error: null,
}

interface ScopeState {
  state: E2eSessionState
  cachedKey: CachedKeyView | null
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
    scope = { state: INITIAL_STATE, cachedKey: null }
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

/**
 * Hydrate the store for a workspace+user. Reads any locally cached bundle
 * from IDB first (so the unlock modal can render immediately), then fetches
 * the server's authoritative copy and reconciles. Idempotent — safe to call
 * on every mount.
 */
export async function loadE2eKeyForUser(workspaceId: string, userId: string): Promise<void> {
  const scope = getOrCreateScope(workspaceId, userId)

  // Already unlocked — bootstrap is a no-op once we're holding the key.
  if (scope.state.status === "unlocked") return

  const cachedRow = await db.e2eKeys.get(`${workspaceId}:${userId}`)
  if (cachedRow) {
    scope.cachedKey = toCachedKeyView(cachedRow)
    setState(workspaceId, userId, {
      status: "locked",
      keyId: scope.cachedKey.keyId,
      publicKey: scope.cachedKey.publicKey,
      error: null,
    })
  }

  let server: Awaited<ReturnType<typeof e2eKeysApi.get>>
  try {
    server = await e2eKeysApi.get(workspaceId)
  } catch {
    // Offline or transient — keep what IDB gave us. If IDB was also empty
    // the scope stays in `unknown`, which the UI treats as "still loading".
    return
  }

  if (!server) {
    scope.cachedKey = null
    await db.e2eKeys.delete(`${workspaceId}:${userId}`)
    setState(workspaceId, userId, { status: "no-key", keyId: null, publicKey: null, privateKey: null, error: null })
    return
  }

  const view: CachedKeyView = {
    keyId: server.keyId,
    publicKey: base64ToBytes(server.publicKey),
    encryptedPrivateBundle: base64ToBytes(server.encryptedPrivateBundle),
    kdfSalt: base64ToBytes(server.kdfSalt),
    kdfParams: server.kdfParams,
  }
  scope.cachedKey = view
  await writeCacheRow(workspaceId, userId, view, server.createdAt)

  // Server may have rotated the key on another device. If so, blow away any
  // unwrapped private key we had — it no longer matches the wrapped bundle.
  const rotatedAway = scope.state.keyId !== null && scope.state.keyId !== view.keyId
  setState(workspaceId, userId, {
    status: "locked",
    keyId: view.keyId,
    publicKey: view.publicKey,
    privateKey: rotatedAway ? null : scope.state.privateKey,
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
  params: KdfParams = DEFAULT_KDF_PARAMS
): Promise<void> {
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

  const view: CachedKeyView = {
    keyId: serverKey.keyId,
    publicKey: base64ToBytes(serverKey.publicKey),
    encryptedPrivateBundle: base64ToBytes(serverKey.encryptedPrivateBundle),
    kdfSalt: base64ToBytes(serverKey.kdfSalt),
    kdfParams: serverKey.kdfParams,
  }
  const scope = getOrCreateScope(workspaceId, userId)
  scope.cachedKey = view
  await writeCacheRow(workspaceId, userId, view, serverKey.createdAt)
  setState(workspaceId, userId, {
    status: "unlocked",
    keyId: view.keyId,
    publicKey: view.publicKey,
    privateKey: uik.privateKey,
    error: null,
  })
}

/**
 * Derive the KEK from the passphrase and unwrap the cached private bundle.
 * Throws with a readable message on wrong-passphrase / tampered-bundle so
 * the modal can render an inline error.
 */
export async function unlock(workspaceId: string, userId: string, passphrase: string): Promise<void> {
  const scope = getOrCreateScope(workspaceId, userId)
  const cached = scope.cachedKey
  if (!cached) {
    throw new Error("No wrapped key available to unlock")
  }
  setState(workspaceId, userId, { status: "unlocking", error: null })
  try {
    const kek = await deriveKEK(passphrase, cached.kdfSalt, cached.kdfParams)
    const privateKey = await unwrapPrivate(cached.encryptedPrivateBundle, kek)
    setState(workspaceId, userId, {
      status: "unlocked",
      keyId: cached.keyId,
      publicKey: cached.publicKey,
      privateKey,
      error: null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to unlock encrypted scratchpads"
    setState(workspaceId, userId, { status: "locked", error: message, privateKey: null })
    throw err
  }
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

  const oldKek = await deriveKEK(oldPassphrase, cached.kdfSalt, cached.kdfParams)
  const privateKey = await unwrapPrivate(cached.encryptedPrivateBundle, oldKek)

  const newSalt = generateSalt()
  const newKek = await deriveKEK(newPassphrase, newSalt, params)
  const wrapped = await wrapPrivate(privateKey, newKek)

  const { key: serverKey } = await e2eKeysApi.set(workspaceId, {
    publicKey: bytesToBase64(cached.publicKey),
    encryptedPrivateBundle: bytesToBase64(wrapped),
    kdfSalt: bytesToBase64(newSalt),
    kdfParams: params,
  })

  const view: CachedKeyView = {
    keyId: serverKey.keyId,
    publicKey: base64ToBytes(serverKey.publicKey),
    encryptedPrivateBundle: base64ToBytes(serverKey.encryptedPrivateBundle),
    kdfSalt: base64ToBytes(serverKey.kdfSalt),
    kdfParams: serverKey.kdfParams,
  }
  scope.cachedKey = view
  await writeCacheRow(workspaceId, userId, view, serverKey.createdAt)
  setState(workspaceId, userId, {
    status: "unlocked",
    keyId: view.keyId,
    publicKey: view.publicKey,
    privateKey,
    error: null,
  })
}

/**
 * Drop the unwrapped private key from memory. The wrapped bundle remains
 * cached in IDB so a subsequent unlock doesn't have to round-trip the
 * server.
 */
export function lock(workspaceId: string, userId: string): void {
  const scope = getOrCreateScope(workspaceId, userId)
  if (!scope.cachedKey) {
    setState(workspaceId, userId, INITIAL_STATE)
    return
  }
  setState(workspaceId, userId, {
    status: "locked",
    keyId: scope.cachedKey.keyId,
    publicKey: scope.cachedKey.publicKey,
    privateKey: null,
    error: null,
  })
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
}

/**
 * Convenience wrappers around the envelope primitives bound to the active
 * unlocked key. Useful from UI flows that want to encrypt/decrypt without
 * threading the private key through every layer.
 */
export async function encryptForSelf(
  workspaceId: string,
  userId: string,
  payload: Uint8Array | string,
  aad?: Uint8Array
) {
  const scope = scopes.get(scopeKey(workspaceId, userId))
  if (!scope?.state.publicKey || !scope.state.keyId) {
    throw new Error("E2E identity key not available")
  }
  return encryptPayload({
    payload,
    aad,
    recipients: [{ recipientKeyId: scope.state.keyId, publicKey: scope.state.publicKey }],
  })
}

export async function decryptFromSelfAsString(
  workspaceId: string,
  userId: string,
  envelope: Parameters<typeof decryptPayloadAsString>[0]["envelope"]
): Promise<string> {
  const privateKey = requireUnlockedPrivateKey(workspaceId, userId)
  const scope = scopes.get(scopeKey(workspaceId, userId))!
  return decryptPayloadAsString({ envelope, privateKey, recipientKeyId: scope.state.keyId! })
}
