import {
  base64ToBytes,
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  unwrapStreamKey,
  wrapStreamKey,
} from "@threa/crypto"
import { e2eKeyWrapsApi } from "@/api/e2e-key-wraps"

/**
 * In-memory cache for per-stream symmetric keys (SSKs).
 *
 * An SSK is the AES-256 key that seals every message in an E2E stream for a
 * given `keyGeneration`. It's never stored in plaintext — the server holds it
 * only HPKE-wrapped to each recipient's long-term key. To use a stream's SSK
 * this device fetches the wrap addressed to its UIK, unwraps it with the
 * in-memory private key, and caches the raw SSK bytes here for the life of the
 * unlocked session.
 *
 * Lifecycle mirrors the decrypt cache: keys live in memory only and are dropped
 * on lock / account switch (`clearStreamKeyCache`) so SSK material never
 * outlives the unlocked session. A wrap fetch is de-duplicated per slot so a
 * burst of message renders for the same stream resolves the SSK once.
 */

interface CachedStreamKey {
  keyGeneration: number
  key: Uint8Array
}

/** SSK bytes keyed by `${workspaceId}:${streamId}:${keyGeneration}`. */
const keys = new Map<string, Uint8Array>()
/** Current generation learned from the last wrap fetch, keyed by `${workspaceId}:${streamId}`. */
const currentGenerations = new Map<string, number>()
const inflight = new Map<string, Promise<Uint8Array | null>>()

function keySlot(workspaceId: string, streamId: string, keyGeneration: number): string {
  return `${workspaceId}:${streamId}:${keyGeneration}`
}

function streamSlot(workspaceId: string, streamId: string): string {
  return `${workspaceId}:${streamId}`
}

export interface ResolveStreamKeyInput {
  workspaceId: string
  streamId: string
  keyGeneration: number
  /** The viewer's UIK key id — selects which wrap row to unwrap. */
  recipientKeyId: string
  /** The viewer's unwrapped UIK private key. */
  privateKey: CryptoKey
}

/**
 * Seed the cache with a locally generated SSK (used at stream-create time, when
 * this device minted the SSK before the server round-trip). Avoids an immediate
 * fetch+unwrap to use a key we already hold in plaintext.
 */
export function putStreamKey(workspaceId: string, streamId: string, keyGeneration: number, key: Uint8Array): void {
  keys.set(keySlot(workspaceId, streamId, keyGeneration), key)
  const prior = currentGenerations.get(streamSlot(workspaceId, streamId))
  if (prior === undefined || keyGeneration > prior) {
    currentGenerations.set(streamSlot(workspaceId, streamId), keyGeneration)
  }
}

export interface ProvisionOwnerStreamKeyInput {
  workspaceId: string
  streamId: string
  /** The owner's UIK key id — the recipient slot the wrap is bound to. */
  ownerKeyId: string
  /** The owner's UIK public key — the wrap is encrypted to it. */
  ownerPublicKey: Uint8Array
}

/**
 * Provision the generation-0 SSK for a freshly created owner-only E2E stream:
 * generate the key, HPKE-wrap it to the owner's UIK (AAD bound to the now-known
 * stream id), store the wrap, and seed the in-memory cache so the first send
 * doesn't re-fetch a key we already hold.
 *
 * This is the single provisioning path (INV-29/35/37) shared by stream-create
 * and the locked-state repair affordance. The create flow mints the stream then
 * calls this; if the wrap store fails the stream is left with zero wraps, and
 * re-running this from the repair CTA finishes setup without a server-side
 * teardown. The caller is responsible for only invoking this when the stream has
 * no existing wraps — re-provisioning a stream that already has a wrap (and thus
 * possibly ciphertext sealed under a different SSK) would orphan that ciphertext.
 */
export async function provisionOwnerStreamKey(input: ProvisionOwnerStreamKeyInput): Promise<void> {
  const ssk = generateStreamKey()
  const wrap = await wrapStreamKey({
    key: ssk,
    recipientPublicKey: input.ownerPublicKey,
    aad: buildWrapAad({ streamId: input.streamId, keyGeneration: 0, recipientKeyId: input.ownerKeyId }),
  })
  await e2eKeyWrapsApi.store(input.workspaceId, input.streamId, {
    wrapEnc: bytesToBase64(wrap.enc),
    wrapCt: bytesToBase64(wrap.ct),
  })
  putStreamKey(input.workspaceId, input.streamId, 0, ssk)
}

/**
 * Resolve the SSK for a specific `(stream, keyGeneration)`. Returns the cached
 * key, or fetches the stream's wraps, unwraps the slot addressed to
 * `recipientKeyId` with the UIK private key, caches it, and returns it. Returns
 * `null` when no wrap exists for this recipient/generation (not a member of
 * that generation) — callers treat that as "can't decrypt".
 */
export async function resolveStreamKey(input: ResolveStreamKeyInput): Promise<Uint8Array | null> {
  const slot = keySlot(input.workspaceId, input.streamId, input.keyGeneration)
  const cached = keys.get(slot)
  if (cached) return cached

  const pending = inflight.get(slot)
  if (pending) return pending

  const promise = fetchAndUnwrap(input, input.keyGeneration)
    .then((res) => res.key)
    .finally(() => {
      inflight.delete(slot)
    })

  inflight.set(slot, promise)
  return promise
}

/**
 * Resolve the SSK for the stream's *current* generation — the one a new send
 * must seal under. Serves a seeded/cached current-generation key without a
 * fetch; otherwise fetches the wrap set once (learning `currentKeyGeneration`)
 * and unwraps that generation's key from the same response.
 */
export async function resolveCurrentStreamKey(
  input: Omit<ResolveStreamKeyInput, "keyGeneration">
): Promise<CachedStreamKey | null> {
  const cachedGen = currentGenerations.get(streamSlot(input.workspaceId, input.streamId))
  if (cachedGen !== undefined) {
    const cachedKey = keys.get(keySlot(input.workspaceId, input.streamId, cachedGen))
    if (cachedKey) return { keyGeneration: cachedGen, key: cachedKey }
  }

  const { keyGeneration, key } = await fetchAndUnwrap(input)
  return key ? { keyGeneration, key } : null
}

/**
 * Single fetch of the stream's wraps, recording `currentKeyGeneration` and
 * unwrapping the slot for `keyGeneration` (defaults to the current one). The
 * one network read serves both the by-generation and current-generation
 * resolvers so neither double-fetches.
 */
async function fetchAndUnwrap(
  input: Omit<ResolveStreamKeyInput, "keyGeneration">,
  keyGeneration?: number
): Promise<{ keyGeneration: number; key: Uint8Array | null }> {
  const { currentKeyGeneration, wraps } = await e2eKeyWrapsApi.get(input.workspaceId, input.streamId)
  currentGenerations.set(streamSlot(input.workspaceId, input.streamId), currentKeyGeneration)

  const generation = keyGeneration ?? currentKeyGeneration
  const wrap = wraps.find((w) => w.keyGeneration === generation && w.recipientKeyId === input.recipientKeyId)
  if (!wrap) return { keyGeneration: generation, key: null }

  const key = await unwrapStreamKey({
    enc: base64ToBytes(wrap.wrapEnc),
    ct: base64ToBytes(wrap.wrapCt),
    recipientPrivateKey: input.privateKey,
    aad: buildWrapAad({ streamId: input.streamId, keyGeneration: generation, recipientKeyId: input.recipientKeyId }),
  })
  keys.set(keySlot(input.workspaceId, input.streamId, generation), key)
  return { keyGeneration: generation, key }
}

/**
 * Drop every cached SSK and generation pointer. Call on session lock and
 * account switch so SSK material never outlives the unlocked session — the
 * same boundary `clearDecryptCache` enforces for decrypted plaintext.
 */
export function clearStreamKeyCache(): void {
  keys.clear()
  currentGenerations.clear()
  inflight.clear()
}
