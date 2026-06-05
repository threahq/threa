import { base64ToBytes, bytesToBase64, exportPrivateKey, importRecipientPrivateKey } from "@threa/crypto"

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
 * Instead we seal the raw X25519 private bytes under a freshly generated,
 * NON-EXTRACTABLE AES-GCM key. AES-GCM keys have round-tripped through on-disk
 * IndexedDB on every engine for a decade, so this survives a cold start.
 *
 * Security posture is unchanged from the previous design: the AES key is
 * non-extractable (`crypto.subtle.exportKey` rejects), so an attacker with the
 * IDB record alone still cannot recover the raw private bytes — the row's mere
 * presence IS the "this device is trusted" state, exactly as before.
 */

const IV_LENGTH = 12

export interface DeviceWrappedKey {
  /** Non-extractable AES-GCM key. Lives only in IndexedDB; never exportable. */
  deviceWrapKey: CryptoKey
  /** base64 of `iv || AES-GCM(ciphertext)` over the raw X25519 private bytes. */
  deviceWrappedPrivate: string
}

/**
 * Seal a private key for device persistence. The caller must hold an
 * EXTRACTABLE key — we export the raw bytes to seal them under the generated
 * AES-GCM key.
 */
export async function wrapPrivateKeyForDevice(privateKey: CryptoKey): Promise<DeviceWrappedKey> {
  const privBytes = await exportPrivateKey(privateKey)
  const deviceWrapKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, deviceWrapKey, privBytes))
  const blob = new Uint8Array(IV_LENGTH + ciphertext.length)
  blob.set(iv, 0)
  blob.set(ciphertext, IV_LENGTH)
  return { deviceWrapKey, deviceWrappedPrivate: bytesToBase64(blob) }
}

/**
 * Recover the UIK private key from a device-wrapped bundle on cold start. Throws
 * if the AES key and ciphertext don't match (corruption / tampering) so the
 * caller can fall back to the unlock prompt.
 */
export async function unwrapPrivateKeyFromDevice(wrapped: DeviceWrappedKey): Promise<CryptoKey> {
  const blob = base64ToBytes(wrapped.deviceWrappedPrivate)
  const iv = blob.slice(0, IV_LENGTH)
  const ciphertext = blob.slice(IV_LENGTH)
  const privBytes = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, wrapped.deviceWrapKey, ciphertext)
  )
  return importRecipientPrivateKey(privBytes, { extractable: true })
}
