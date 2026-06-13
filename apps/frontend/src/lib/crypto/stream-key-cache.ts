import {
  base64ToBytes,
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  unwrapStreamKey,
  wrapStreamKey,
} from "@threa/crypto"
import type { E2eKeyRollRecipient, E2eKeyWrapsResponse } from "@threa/types"
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

/** One (live actor key, generation) slot whose SSK wrap is missing. */
export interface MissingActorWrap {
  recipient: E2eKeyRollRecipient
  keyGeneration: number
}

/**
 * Which wrap slots a revive must fill, from one key-wraps fetch. Every live
 * actor key needs the current generation (the classic enclave-restart heal).
 * Enclave recipients additionally need every older generation some enclave
 * wrap already exists at: the enclave is a singleton actor, so a prior
 * enclave wrap at a generation proves the actor held it — and a restart
 * orphans ALL of its generations, not just the current one. Healing only the
 * current generation leaves a turn parked under a pre-roll generation
 * stranded until DLQ (E2EE-7), and old sealed history and turn digests
 * unreadable. Bots stay current-only: their wraps carry no per-bot identity,
 * so older generations can't be attributed to the specific bot that held
 * them (the server rejects the attempt).
 *
 * Shared by the revive itself and the affordance probe that decides whether
 * to fire it, so "is anything missing" can't drift from "what gets healed".
 */
export function computeMissingActorWraps(
  data: Pick<E2eKeyWrapsResponse, "currentKeyGeneration" | "wraps"> & {
    /** `undefined` tolerates a not-yet-redeployed backend that omits the field. */
    liveActorRecipients: E2eKeyRollRecipient[] | undefined
  }
): MissingActorWrap[] {
  const { currentKeyGeneration, wraps } = data
  const hasWrap = (recipientKeyId: string, keyGeneration: number) =>
    wraps.some((w) => w.keyGeneration === keyGeneration && w.recipientKeyId === recipientKeyId)
  const enclaveHeldGenerations = [
    ...new Set(
      wraps
        .filter((w) => w.recipientKind === "enclave" && w.keyGeneration < currentKeyGeneration)
        .map((w) => w.keyGeneration)
    ),
  ]

  const missing: MissingActorWrap[] = []
  for (const recipient of data.liveActorRecipients ?? []) {
    if (!hasWrap(recipient.recipientKeyId, currentKeyGeneration)) {
      missing.push({ recipient, keyGeneration: currentKeyGeneration })
    }
    if (recipient.recipientKind !== "enclave") continue
    for (const keyGeneration of enclaveHeldGenerations) {
      if (!hasWrap(recipient.recipientKeyId, keyGeneration)) {
        missing.push({ recipient, keyGeneration })
      }
    }
  }
  return missing
}

/** De-dupes concurrent revives per stream (header probe + send firing together). */
const reviveInflight = new Map<string, Promise<ReviveActorWrapsResult>>()

/**
 * Re-wrap already-granted SSK generations to invited actors' live keys that
 * are missing their wrap — the heal for an enclave restart, whose fresh EIK
 * orphans every stream wrapped to its predecessor (parking enclave turns
 * server-side until this runs). Unlike `rekeyStream`, no fresh SSK and no
 * generation bump: the actor already held these generations, so the new
 * instance gets exactly the prior access — and a parked turn stays
 * decryptable, which a roll would strand. `computeMissingActorWraps` decides
 * the slots; every generation the owner can open is re-wrapped, and one it
 * can't is skipped rather than failing the rest.
 *
 * Owner-only (the server enforces it; `"not-owner"` short-circuits everyone
 * else). Returns `"none-missing"` when every live actor key already has its
 * wraps, `"no-key"` when no missing generation's SSK can be recovered from
 * the owner's own wraps (nothing to re-wrap), `"revived"` after storing the
 * missing wraps.
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
  const data = await e2eKeyWrapsApi.get(input.workspaceId, input.streamId)
  const { currentKeyGeneration, ownerUserId } = data
  currentGenerations.set(streamSlot(input.workspaceId, input.streamId), currentKeyGeneration)

  if (ownerUserId !== input.userId) return "not-owner"

  const missing = computeMissingActorWraps(data)
  if (missing.length === 0) return "none-missing"

  // Recover each missing generation's SSK from the owner's own wrap in the
  // response we already hold (at send time the current generation is normally
  // already cached). A generation the owner can't open — no owner wrap, or an
  // unwrap failure — is skipped so it can't block healing the rest.
  const sskByGeneration = new Map<number, Uint8Array>()
  for (const keyGeneration of new Set(missing.map((m) => m.keyGeneration))) {
    const ssk = await unwrapOwnerGeneration(input, data, keyGeneration)
    if (ssk) sskByGeneration.set(keyGeneration, ssk)
  }
  const wrappable = missing.filter((m) => sskByGeneration.has(m.keyGeneration))
  if (wrappable.length === 0) return "no-key"

  const rewraps = await Promise.all(
    wrappable.map(async ({ recipient, keyGeneration }) => {
      const wrap = await wrapStreamKey({
        key: sskByGeneration.get(keyGeneration)!,
        recipientPublicKey: base64ToBytes(recipient.publicKey),
        aad: buildWrapAad({
          streamId: input.streamId,
          keyGeneration,
          recipientKeyId: recipient.recipientKeyId,
        }),
      })
      return {
        keyGeneration,
        recipientKeyId: recipient.recipientKeyId,
        recipientKind: recipient.recipientKind,
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
 * Unwrap the owner's SSK for one generation from an already-fetched wrap set,
 * serving the in-memory cache first and seeding it on success. Returns `null`
 * (never throws) when the owner holds no wrap at the generation or the unwrap
 * fails — revive callers treat that generation as unopenable and move on.
 */
async function unwrapOwnerGeneration(
  input: ReviveActorWrapsInput,
  data: Pick<E2eKeyWrapsResponse, "wraps">,
  keyGeneration: number
): Promise<Uint8Array | null> {
  const cached = keys.get(keySlot(input.workspaceId, input.streamId, keyGeneration))
  if (cached) return cached

  const ownerWrap = data.wraps.find((w) => w.keyGeneration === keyGeneration && w.recipientKeyId === input.ownerKeyId)
  if (!ownerWrap) return null
  try {
    const key = await unwrapStreamKey({
      enc: base64ToBytes(ownerWrap.wrapEnc),
      ct: base64ToBytes(ownerWrap.wrapCt),
      recipientPrivateKey: input.ownerPrivateKey,
      aad: buildWrapAad({ streamId: input.streamId, keyGeneration, recipientKeyId: input.ownerKeyId }),
    })
    keys.set(keySlot(input.workspaceId, input.streamId, keyGeneration), key)
    return key
  } catch {
    return null
  }
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
