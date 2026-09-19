import type { SealedDecisionContent } from "@threahq/types"
import { createDecryptedCache, type DecryptStatus } from "./decrypted-cache"
import { tryOpenSealedDecision, tryOpenSealedDecisionNote, type SealedDecisionWire } from "./decision-card"
import type { DecryptMessageOpts } from "./message-envelope"

/**
 * In-memory caches for the two sealed halves of a decision card — the question
 * a bot asked, and the note its human wrote back — as keyed-subscription
 * instances of the shared {@link createDecryptedCache} primitive.
 *
 * Both are keyed by `${decisionId}:${ciphertext}`: the id names the slot and the
 * ciphertext makes the key content-addressed, so a card and the note that
 * answers it never collide and a re-read can't serve an older body. Plaintext
 * lives only here and is dropped on lock like every other decrypted cache.
 *
 * `retryFailed` is on for the same reason stream names use it: a null open on a
 * card is usually transient (the SSK wrap hasn't synced yet), and pinning the
 * locked card forever would outlive the cause.
 */

interface CardEntry {
  status: DecryptStatus
  value: SealedDecisionContent | null
}

interface NoteEntry {
  status: DecryptStatus
  value: string | null
}

const cards = createDecryptedCache<CardEntry>({
  subscription: "per-key",
  lru: 200,
  retryFailed: true,
  pending: () => ({ status: "pending", value: null }),
})

const notes = createDecryptedCache<NoteEntry>({
  subscription: "per-key",
  lru: 200,
  retryFailed: true,
  pending: () => ({ status: "pending", value: null }),
})

export function sealedDecisionCacheKey(decisionId: string, ciphertext: string): string {
  return `${decisionId}:${ciphertext}`
}

export function getCachedSealedDecision(key: string): CardEntry | undefined {
  return cards.peek(key)
}

export function subscribeSealedDecision(key: string, listener: () => void): () => void {
  return cards.subscribe(key, listener)
}

export function requestSealedDecision(
  key: string,
  payload: SealedDecisionWire,
  opts: DecryptMessageOpts
): Promise<CardEntry> {
  return cards.request(key, async () => {
    const content = await tryOpenSealedDecision(payload, opts)
    return content ? { status: "decrypted", value: content } : { status: "failed", value: null }
  })
}

export function getCachedSealedDecisionNote(key: string): NoteEntry | undefined {
  return notes.peek(key)
}

export function subscribeSealedDecisionNote(key: string, listener: () => void): () => void {
  return notes.subscribe(key, listener)
}

export function requestSealedDecisionNote(
  key: string,
  payload: { streamId: string; decisionId: string; decidedBy: string; ciphertext: string; envelope: unknown },
  opts: DecryptMessageOpts
): Promise<NoteEntry> {
  return notes.request(key, async () => {
    const note = await tryOpenSealedDecisionNote(payload, opts)
    return note === null ? { status: "failed", value: null } : { status: "decrypted", value: note }
  })
}

/**
 * Seed the note this client just sealed and sent, so the card shows the words
 * the viewer typed the moment the answer lands instead of decrypting its own
 * write back through the wraps.
 */
export function primeSealedDecisionNote(key: string, note: string): void {
  notes.prime(key, { status: "decrypted", value: note })
}
