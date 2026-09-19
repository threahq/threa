import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { StreamEnvelope } from "@threahq/crypto"
import type { DecisionRequest, DecisionResolution, SealedDecisionContent } from "@threahq/types"
import {
  getCachedSealedDecision,
  getCachedSealedDecisionNote,
  primeSealedDecisionNote,
  requestSealedDecision,
  requestSealedDecisionNote,
  sealedDecisionCacheKey,
  subscribeSealedDecision,
  subscribeSealedDecisionNote,
} from "@/lib/crypto/decision-cache"
import { sealDecisionNote, type SealedDecisionWire } from "@/lib/crypto/decision-card"
import { resolveDecryptContext } from "@/lib/crypto/decrypt-context"
import { useE2eSession } from "@/stores/e2e-session-store"
import { useStreamFromStore } from "@/stores/stream-store"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"

/** Seal a note for this card under the stream's current SSK, ready to send. */
type SealNote = (note: string) => Promise<{ ciphertext: string; envelope: StreamEnvelope }>

type DecryptedDecisionState =
  | { status: "plaintext"; content: null; note: null }
  | { status: "locked" | "pending" | "failed"; content: null; note: null }
  | { status: "decrypted"; content: SealedDecisionContent; note: string | null }

/**
 * The read (and write-back) side of a sealed decision card.
 *
 * On an encrypted stream a card's `title`, `bodyMarkdown` and option labels are
 * placeholders on the wire and the requester's real words are in `ciphertext`;
 * the note its human writes back is sealed the same way. This is the one hook
 * that opens both, following the shared decrypt layer: cache instances for the
 * plaintext, `resolveDecryptContext` for the session + root-SSK gate, primitive
 * effect deps so a settled decrypt doesn't re-fire on unrelated row updates.
 *
 *  - `plaintext` — the card isn't sealed; render the payload as it arrived.
 *  - `locked`    — sealed, and the session isn't unlocked.
 *  - `pending`   — decrypt in flight (or the stream row not hydrated yet).
 *  - `decrypted` — render `content`, and `note` if the answer carried one.
 *  - `failed`    — the SSK, the AAD check or the body didn't hold up.
 *
 * `sealNote` is non-null exactly when this viewer can seal a note for this card.
 * It primes the note cache with what it sealed, so the answer shows the viewer's
 * own words the moment it lands rather than decrypting its own write back.
 */
export type DecryptedDecision = DecryptedDecisionState & { sealNote: SealNote | null }

/**
 * The sealed card on the wire, or null for a plaintext one. A sealed card always
 * names the bot that asked — the public API opens cards for bot keys only — so a
 * card with no requester has no AAD to check and is treated as unsealed.
 */
function readSealedCard(decision: DecisionRequest | undefined): SealedDecisionWire | null {
  if (!decision?.ciphertext || !decision.envelope || !decision.requesterBotId) return null
  return {
    streamId: decision.streamId,
    decisionId: decision.id,
    requesterBotId: decision.requesterBotId,
    ciphertext: decision.ciphertext,
    envelope: decision.envelope,
  }
}

export function useDecryptedDecision(
  workspaceId: string,
  decision: DecisionRequest | undefined,
  resolution: DecisionResolution | undefined
): DecryptedDecision {
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const sealed = useMemo(() => readSealedCard(decision), [decision])
  // The card's own stream; a thread's SSK resolves against its root, which is
  // why the row has to be in hand before any decrypt is attempted.
  const stream = useStreamFromStore(sealed?.streamId)
  const ctx = resolveDecryptContext(workspaceId, sealed?.streamId ?? "", session, stream)
  const opts = sealed && ctx.ready ? ctx.opts : null

  const cardKey = sealed ? sealedDecisionCacheKey(sealed.decisionId, sealed.ciphertext) : ""
  const cachedCard = useSyncExternalStore(
    (listener) => subscribeSealedDecision(cardKey, listener),
    () => getCachedSealedDecision(cardKey),
    () => undefined
  )

  const noteCiphertext = sealed && resolution?.noteCiphertext ? resolution.noteCiphertext : null
  const noteKey = sealed && noteCiphertext ? sealedDecisionCacheKey(sealed.decisionId, noteCiphertext) : ""
  const cachedNote = useSyncExternalStore(
    (listener) => subscribeSealedDecisionNote(noteKey, listener),
    () => getCachedSealedDecisionNote(noteKey),
    () => undefined
  )

  const cardStatus = cachedCard?.status
  useEffect(() => {
    if (!sealed || !opts) return
    if (cardStatus === "decrypted" || cardStatus === "failed") return
    void requestSealedDecision(cardKey, sealed, opts)
    // Primitive opts fields, never the per-render object (see the decrypt layer
    // notes in apps/frontend/CLAUDE.md).
  }, [
    sealed,
    cardKey,
    cardStatus,
    opts?.privateKey,
    opts?.recipientKeyId,
    opts?.workspaceId,
    opts?.streamId,
    opts?.rootStreamId,
  ])

  const noteStatus = cachedNote?.status
  const noteEnvelope = resolution?.noteEnvelope
  const decidedBy = resolution?.decidedBy
  useEffect(() => {
    if (!sealed || !opts || !noteCiphertext || !noteEnvelope || !decidedBy) return
    if (noteStatus === "decrypted" || noteStatus === "failed") return
    void requestSealedDecisionNote(
      noteKey,
      {
        streamId: sealed.streamId,
        decisionId: sealed.decisionId,
        decidedBy,
        ciphertext: noteCiphertext,
        envelope: noteEnvelope,
      },
      opts
    )
  }, [
    sealed,
    noteKey,
    noteStatus,
    noteCiphertext,
    noteEnvelope,
    decidedBy,
    opts?.privateKey,
    opts?.recipientKeyId,
    opts?.workspaceId,
    opts?.streamId,
    opts?.rootStreamId,
  ])

  const keyStreamId = stream?.rootStreamId ?? sealed?.streamId
  const sealNote = useMemo<SealNote | null>(() => {
    if (!sealed || !userId || !keyStreamId) return null
    return async (note: string) => {
      const result = await sealDecisionNote({
        workspaceId,
        keyStreamId,
        streamId: sealed.streamId,
        decisionId: sealed.decisionId,
        decidedBy: userId,
        note,
      })
      primeSealedDecisionNote(sealedDecisionCacheKey(sealed.decisionId, result.ciphertext), note)
      return result
    }
  }, [sealed, userId, keyStreamId, workspaceId])

  if (!sealed) return { status: "plaintext", content: null, note: null, sealNote: null }
  // "locked" is specifically a locked session; unlocked-but-unhydrated stays
  // `pending` so the decrypt fires as soon as the stream row lands.
  if (!ctx.ready && ctx.reason === "locked") return { status: "locked", content: null, note: null, sealNote }
  if (cachedCard?.status === "decrypted" && cachedCard.value) {
    return { status: "decrypted", content: cachedCard.value, note: cachedNote?.value ?? null, sealNote }
  }
  if (cachedCard?.status === "failed") return { status: "failed", content: null, note: null, sealNote }
  return { status: "pending", content: null, note: null, sealNote }
}
