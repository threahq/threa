import {
  base64ToBytes,
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  unwrapStreamKey,
  wrapStreamKey,
} from "@threa/crypto"
import type { E2eKeyRollRecipient } from "@threa/types"
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

export interface RekeyStreamInput {
  workspaceId: string
  streamId: string
  /** The generation to mint — `currentKeyGeneration + 1`, from the invite response. */
  nextGeneration: number
  /** The owner's UIK key id — the recipient slot the owner's own wrap binds to. */
  ownerKeyId: string
  /** The owner's UIK public key — the owner's wrap is encrypted to it. */
  ownerPublicKey: Uint8Array
  /** Every invited actor key the SSK must also be wrapped to (bot BIKs, enclave EIKs). */
  actorRecipients: E2eKeyRollRecipient[]
}

/**
 * Roll a stream's SSK forward after a recipient-set change (inviting an actor).
 * Mints a fresh SSK at `nextGeneration`, wraps it to the owner's UIK plus every
 * actor recipient (each AAD bound to this stream + generation + recipient), and
 * POSTs the batch; the server stores it and bumps the generation atomically.
 * Seeds the cache with the new SSK so the owner's next send seals under it
 * without a refetch.
 *
 * A fresh key (not a re-wrap of the old SSK) is the point: history stays sealed
 * under the prior generation, which a later-removed actor can still open with
 * the wrap it already holds but a newly-added actor cannot — it has no wrap for
 * any generation before this one.
 */
export async function rekeyStream(input: RekeyStreamInput): Promise<void> {
  const ssk = generateStreamKey()
  const recipients = [
    { recipientKeyId: input.ownerKeyId, recipientKind: "user" as const, publicKey: input.ownerPublicKey },
    ...input.actorRecipients.map((r) => ({
      recipientKeyId: r.recipientKeyId,
      recipientKind: r.recipientKind,
      publicKey: base64ToBytes(r.publicKey),
    })),
  ]

  const wraps = await Promise.all(
    recipients.map(async (r) => {
      const wrap = await wrapStreamKey({
        key: ssk,
        recipientPublicKey: r.publicKey,
        aad: buildWrapAad({
          streamId: input.streamId,
          keyGeneration: input.nextGeneration,
          recipientKeyId: r.recipientKeyId,
        }),
      })
      return {
        recipientKeyId: r.recipientKeyId,
        recipientKind: r.recipientKind,
        wrapEnc: bytesToBase64(wrap.enc),
        wrapCt: bytesToBase64(wrap.ct),
      }
    })
  )

  await e2eKeyWrapsApi.roll(input.workspaceId, input.streamId, { keyGeneration: input.nextGeneration, wraps })
  putStreamKey(input.workspaceId, input.streamId, input.nextGeneration, ssk)
}

export interface ReviveActorWrapsInput {
  workspaceId: string
  streamId: string
  /** The caller's workspace user id — only the stream owner may revive. */
  userId: string
  /** The owner's UIK key id — selects the wrap to recover the SSK from. */
  ownerKeyId: string
  /** The owner's unwrapped UIK private key. */
  ownerPrivateKey: CryptoKey
}

export type ReviveActorWrapsResult = "revived" | "none-missing" | "not-owner" | "no-key"

/** De-dupes concurrent revives per stream (header probe + send firing together). */
const reviveInflight = new Map<string, Promise<ReviveActorWrapsResult>>()

/**
 * Re-wrap the *current* SSK to invited actors' live keys that are missing a
 * wrap at the current generation — the heal for an enclave restart, whose
 * fresh EIK orphans every stream wrapped to its predecessor (parking enclave
 * turns server-side until this runs). Unlike `rekeyStream`, no fresh SSK and
 * no generation bump: the actor already held this generation, so the new
 * instance gets exactly the prior access — and a parked turn (sealed under
 * the current generation) stays decryptable, which a roll would strand.
 *
 * Owner-only (the server enforces it; `"not-owner"` short-circuits everyone
 * else). Returns `"none-missing"` when every live actor key already has its
 * wrap, `"no-key"` when the owner's own wrap can't be recovered (nothing to
 * re-wrap), `"revived"` after storing the missing wraps.
 */
export async function reviveStaleActorWraps(input: ReviveActorWrapsInput): Promise<ReviveActorWrapsResult> {
  const slot = streamSlot(input.workspaceId, input.streamId)
  const pending = reviveInflight.get(slot)
  if (pending) return pending

  const promise = doReviveStaleActorWraps(input).finally(() => {
    reviveInflight.delete(slot)
  })
  reviveInflight.set(slot, promise)
  return promise
}

async function doReviveStaleActorWraps(input: ReviveActorWrapsInput): Promise<ReviveActorWrapsResult> {
  // Always a fresh fetch: the point is to see an EIK that registered after
  // whatever the UI has cached.
  const { currentKeyGeneration, wraps, liveActorRecipients, ownerUserId } = await e2eKeyWrapsApi.get(
    input.workspaceId,
    input.streamId
  )
  currentGenerations.set(streamSlot(input.workspaceId, input.streamId), currentKeyGeneration)

  if (ownerUserId !== input.userId) return "not-owner"

  // `?? []` tolerates a not-yet-redeployed backend that omits the field.
  const missing = (liveActorRecipients ?? []).filter(
    (r) => !wraps.some((w) => w.keyGeneration === currentKeyGeneration && w.recipientKeyId === r.recipientKeyId)
  )
  if (missing.length === 0) return "none-missing"

  // At send time the seal path has already cached this generation's SSK, so
  // this is normally a cache hit; on a cold open it unwraps the owner's slot.
  const ssk = await resolveStreamKey({
    workspaceId: input.workspaceId,
    streamId: input.streamId,
    keyGeneration: currentKeyGeneration,
    recipientKeyId: input.ownerKeyId,
    privateKey: input.ownerPrivateKey,
  })
  if (!ssk) return "no-key"

  const rewraps = await Promise.all(
    missing.map(async (r) => {
      const wrap = await wrapStreamKey({
        key: ssk,
        recipientPublicKey: base64ToBytes(r.publicKey),
        aad: buildWrapAad({
          streamId: input.streamId,
          keyGeneration: currentKeyGeneration,
          recipientKeyId: r.recipientKeyId,
        }),
      })
      return {
        recipientKeyId: r.recipientKeyId,
        recipientKind: r.recipientKind,
        wrapEnc: bytesToBase64(wrap.enc),
        wrapCt: bytesToBase64(wrap.ct),
      }
    })
  )

  await e2eKeyWrapsApi.reviveActorWraps(input.workspaceId, input.streamId, {
    keyGeneration: currentKeyGeneration,
    wraps: rewraps,
  })
  return "revived"
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
