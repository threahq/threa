import { getE2eSessionState } from "@/stores/e2e-session-store"
import { sealStreamName } from "@/lib/crypto/message-envelope"
import { resolveCurrentStreamKey } from "@/lib/crypto/stream-key-cache"
import { primeStreamName, streamNameCacheKey } from "@/lib/crypto/stream-name-cache"

/** Sealed-name PATCH fields for an E2E rename — sent WITHOUT a plaintext `displayName`. */
export interface SealedNameFields {
  sealedNameCiphertext: string
  sealedNameEnvelope: unknown
}

/**
 * Thrown when an E2E stream can't be renamed because no stream key is available
 * to seal the new name (the session is locked, or the SSK can't be resolved).
 * The rename affordance is gated on the unlocked state; this is the backstop
 * that guarantees a rename never silently falls back to writing the name as
 * plaintext — the leak this module exists to remove.
 */
export class StreamNameSealUnavailableError extends Error {
  constructor(public readonly reason: "locked" | "no-stream-key") {
    super(`Cannot seal stream name: ${reason}`)
    this.name = "StreamNameSealUnavailableError"
  }
}

/**
 * Seal a new display name for an E2E stream so a rename persists ONLY the
 * tamper-evident ciphertext (AAD-bound to the stream) — the server never
 * receives the cleartext name (INV-E1). Mirrors the enclave auto-title's sealed-only
 * write (`setSealedNameIfAbsent`). The single sealing path for every rename
 * surface (open-stream header + stream settings); both call this rather than
 * re-deriving the seal. Throws — never returns a plaintext fallback — when the
 * session is locked or the SSK can't be resolved.
 */
export async function sealStreamRename(params: {
  workspaceId: string
  streamId: string
  userId: string
  name: string
}): Promise<SealedNameFields> {
  const { workspaceId, streamId, userId, name } = params
  const session = getE2eSessionState(workspaceId, userId)
  if (session.status !== "unlocked" || !session.privateKey || !session.keyId) {
    throw new StreamNameSealUnavailableError("locked")
  }
  const streamKey = await resolveCurrentStreamKey({
    workspaceId,
    streamId,
    recipientKeyId: session.keyId,
    privateKey: session.privateKey,
  })
  if (!streamKey) {
    throw new StreamNameSealUnavailableError("no-stream-key")
  }
  const sealed = await sealStreamName({
    name,
    streamId,
    ssk: streamKey.key,
    keyGeneration: streamKey.keyGeneration,
  })
  // Seed the decrypt cache with the cleartext we just sealed, keyed by the fresh
  // ciphertext, so the header and list overlay show the new name the moment the
  // stream row flips to it — without flashing the placeholder while a re-decrypt
  // of our own write round-trips (the rename flicker).
  primeStreamName(streamNameCacheKey(workspaceId, streamId, sealed.ciphertext), name)
  return { sealedNameCiphertext: sealed.ciphertext, sealedNameEnvelope: sealed.envelope }
}
