/**
 * Tiny base64 / bytes helpers shared by the crypto modules.
 *
 * The browser's `btoa`/`atob` only speak Latin-1 strings, so we use the
 * `Uint8Array` ↔ binary-string trick. This is the same approach used by
 * standards libraries and is well under a millisecond for the key-sized
 * inputs we deal with here.
 *
 * Return types are pinned to `Uint8Array<ArrayBuffer>` so the bytes are
 * directly usable with `crypto.subtle.{encrypt,decrypt}` — TypeScript's
 * `BufferSource` rejects the default `Uint8Array<ArrayBufferLike>` because
 * it can't prove the buffer isn't shared. We never produce SharedArrayBuffer
 * here, so the narrower type is accurate.
 */

export function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]!)
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  // TextEncoder always writes into a fresh ArrayBuffer-backed array; the
  // generic parameter narrowing isn't reflected in lib.dom, so we re-state it.
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/**
 * Concatenate byte arrays into a single Uint8Array. Used to build envelope
 * AAD (streamId ‖ messageId ‖ senderId).
 */
export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}
