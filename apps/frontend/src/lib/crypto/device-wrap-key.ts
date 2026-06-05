import { base64ToBytes, bytesToBase64 } from "@threa/crypto"
import { unwrapPrivate, wrapPrivate } from "./keys"

/**
 * "Keep me unlocked on this device" at-rest sealing.
 *
 * We deliberately do NOT persist the UIK's X25519 private key as a `CryptoKey`.
 * Some browsers (observed on Android Chrome) resolve the IndexedDB write — so
 * the caller sees success — but silently drop the newer X25519/Ed25519
 * `CryptoKey` when the database is flushed to disk. A page reload within the
 * same session still finds it (it's in the in-memory IDB), but a true cold
 * start reads the row back without the key and forces a re-unlock. That made
 * "keep me unlocked" effectively a no-op across app restarts.
 *
 * Instead we seal the private key under a freshly generated, NON-EXTRACTABLE
 * AES-GCM key, reusing the same `wrapPrivate` / `unwrapPrivate` primitives the
 * PIN and biometric device-unlock paths use — here the generated AES key is
 * itself the KEK. AES-GCM keys round-trip through on-disk IndexedDB on every
 * engine, so this survives a cold start.
 *
 * Security posture is unchanged: the AES key is non-extractable
 * (`crypto.subtle.exportKey` rejects), so an attacker with the IDB record alone
 * still cannot recover the raw private bytes — the row's mere presence IS the
 * "this device is trusted" state.
 */

export interface DeviceWrappedKey {
  /** Non-extractable AES-GCM KEK. Lives only in IndexedDB; never exportable. */
  deviceWrapKey: CryptoKey
  /** base64 `wrapPrivate` bundle (version + iv + AES-GCM ciphertext). */
  deviceWrappedPrivate: string
}

/** A non-extractable AES-GCM key used as the KEK that seals the private key. */
function generateDeviceKek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
}

/**
 * Seal a private key for device persistence. The caller must hold an
 * EXTRACTABLE key — `wrapPrivate` exports the raw bytes to seal them.
 */
export async function wrapPrivateKeyForDevice(privateKey: CryptoKey): Promise<DeviceWrappedKey> {
  const deviceWrapKey = await generateDeviceKek()
  const bundle = await wrapPrivate(privateKey, deviceWrapKey)
  return { deviceWrapKey, deviceWrappedPrivate: bytesToBase64(bundle) }
}

/**
 * Recover the UIK private key from a device-wrapped bundle on cold start. Throws
 * if the AES key and bundle don't match (corruption / tampering) so the caller
 * can fall back to the unlock prompt.
 */
export async function unwrapPrivateKeyFromDevice(wrapped: DeviceWrappedKey): Promise<CryptoKey> {
  return unwrapPrivate(base64ToBytes(wrapped.deviceWrappedPrivate), wrapped.deviceWrapKey)
}
