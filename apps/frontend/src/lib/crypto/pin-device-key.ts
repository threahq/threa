import { base64ToBytes, bytesToBase64 } from "@threa/crypto"
import { DEFAULT_KDF_PARAMS, deriveKEK, generateSalt, type KdfParams } from "./passphrase"
import { unwrapPrivate, wrapPrivate } from "./keys"

/**
 * PIN-gated device quick-unlock.
 *
 * A short PIN (6–8 digits) is low-entropy, so it ONLY ever guards key material
 * that already lives on a trusted device — the local "keep me unlocked" key. An
 * attacker needs the device's IndexedDB *and* the PIN, and a local attempt
 * lockout (see `MAX_PIN_ATTEMPTS`) bounds online guessing. The passphrase stays
 * the recovery root; the PIN never leaves the device and is never sent anywhere.
 *
 * Mechanically this is the same AES-GCM-around-the-X25519-private-key wrap the
 * passphrase path uses (`keys.ts`), just keyed by an Argon2id KEK derived from
 * the PIN instead of the passphrase. We reuse those primitives rather than
 * inventing a second crypto path.
 */

export const PIN_MIN_DIGITS = 6
export const PIN_MAX_DIGITS = 8

/** Failed PIN attempts before the device PIN is dropped and the passphrase is required. */
export const MAX_PIN_ATTEMPTS = 5

const PIN_PATTERN = new RegExp(`^\\d{${PIN_MIN_DIGITS},${PIN_MAX_DIGITS}}$`)

/** A PIN is 6–8 digits, nothing else. UI enforces this too; this is the gate. */
export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin)
}

/** Stored, server-never-sees-it material for a PIN-protected device key. */
export interface PinWrappedKey {
  /** base64 of `wrapPrivate` output (version + iv + AES-GCM ciphertext). */
  pinWrappedPrivate: string
  /** base64 Argon2id salt. */
  pinSalt: string
  pinKdfParams: KdfParams
}

/**
 * Wrap the UIK private key under a PIN-derived KEK. The caller must hold an
 * *extractable* private key (e.g. straight from setup, or `unwrapPrivate(...,
 * { extractable: true })`) — `wrapPrivate` exports the raw bytes to seal them.
 */
export async function wrapPrivateKeyWithPin(
  privateKey: CryptoKey,
  pin: string,
  params: KdfParams = DEFAULT_KDF_PARAMS
): Promise<PinWrappedKey> {
  if (!isValidPin(pin)) throw new Error("PIN must be 6–8 digits")
  const salt = generateSalt()
  const kek = await deriveKEK(pin, salt, params)
  const bundle = await wrapPrivate(privateKey, kek)
  return { pinWrappedPrivate: bytesToBase64(bundle), pinSalt: bytesToBase64(salt), pinKdfParams: params }
}

/**
 * Recover the UIK private key from a PIN-wrapped bundle. Returns a
 * NON-EXTRACTABLE key (the unlock path never needs the raw bytes again).
 * Throws on the wrong PIN — the AES-GCM tag check fails — so callers can count
 * the failure toward the lockout.
 */
export async function unwrapPrivateKeyWithPin(wrapped: PinWrappedKey, pin: string): Promise<CryptoKey> {
  const kek = await deriveKEK(pin, base64ToBytes(wrapped.pinSalt), wrapped.pinKdfParams)
  return unwrapPrivate(base64ToBytes(wrapped.pinWrappedPrivate), kek)
}
