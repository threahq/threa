import {
  base64ToBytes,
  buildDecisionAad,
  buildDecisionNoteAad,
  bytesToBase64,
  openMessageAsString,
  sealMessage,
  type StreamEnvelope,
} from "@threahq/crypto"
import type { SealedDecisionContent } from "@threahq/types"
import { getE2eSessionState } from "@/stores/e2e-session-store"
import { resolveCurrentStreamKey, resolveStreamKey } from "./stream-key-cache"
import { parseStreamEnvelope, type DecryptMessageOpts } from "./message-envelope"

/**
 * The sealed half of a decision card, and the note a member writes back.
 *
 * A card on an encrypted stream stores placeholders in `title`, `bodyMarkdown`
 * and every option `label`; the real words live in `ciphertext`, sealed under
 * the stream's SSK and AAD-bound to `streamId|decision|decisionId|
 * requesterBotId`. The note rides the same way under a `decision-note` label
 * bound to the answering user. Option ids and tones stay in the clear so the
 * server can validate an answer against them; the labels are sealed, so a card
 * that won't open shows a notice in place of its question and buttons.
 */

export interface SealedDecisionWire {
  streamId: string
  decisionId: string
  requesterBotId: string
  ciphertext: string
  envelope: unknown
}

/**
 * Open a sealed decision card into the words its requester wrote. Returns null
 * for an unparseable envelope, an AAD that doesn't name this exact card, an SSK
 * that can't be resolved (locked / not a recipient), a forged tag, or a body
 * that isn't a `SealedDecisionContent` — every one of which leaves the caller
 * showing the locked card rather than text it can't trust.
 *
 * The AAD check is the part `openMessage` can't do for us: it decrypts with
 * whatever AAD the envelope carries, so only comparing that against the AAD
 * this card's own slot implies catches a server that moved a card between
 * streams sharing a key (a thread and its root) or relabelled whose question
 * it is.
 */
export async function tryOpenSealedDecision(
  payload: SealedDecisionWire,
  opts: DecryptMessageOpts
): Promise<SealedDecisionContent | null> {
  const expected = bytesToBase64(
    buildDecisionAad({
      streamId: payload.streamId,
      decisionId: payload.decisionId,
      requesterBotId: payload.requesterBotId,
    })
  )
  const raw = await openSealed(payload.ciphertext, payload.envelope, expected, opts)
  if (raw === null) return null
  return parseSealedDecisionContent(raw)
}

/** Open a sealed decision note, bound to the card and to who answered it. */
export async function tryOpenSealedDecisionNote(
  payload: { streamId: string; decisionId: string; decidedBy: string; ciphertext: string; envelope: unknown },
  opts: DecryptMessageOpts
): Promise<string | null> {
  const expected = bytesToBase64(
    buildDecisionNoteAad({
      streamId: payload.streamId,
      decisionId: payload.decisionId,
      decidedBy: payload.decidedBy,
    })
  )
  return openSealed(payload.ciphertext, payload.envelope, expected, opts)
}

/**
 * Seal the note a member attaches to their answer, under the stream's current
 * SSK. Throws loudly (INV-11) when the session is locked or the viewer isn't a
 * recipient of the current generation: a sealed card only accepts a sealed note
 * (INV-E1), so a silent plaintext fallback would be rejected at the door anyway.
 */
export async function sealDecisionNote(input: {
  workspaceId: string
  /** The E2E stream whose current SSK seals the note — the root for a thread. */
  keyStreamId: string
  /** The stream the card lives on — binds the AAD. */
  streamId: string
  decisionId: string
  decidedBy: string
  note: string
}): Promise<{ ciphertext: string; envelope: StreamEnvelope }> {
  const session = getE2eSessionState(input.workspaceId, input.decidedBy)
  if (session.status !== "unlocked" || !session.privateKey || !session.keyId) {
    throw new Error("Unlock this scratchpad before answering")
  }
  const streamKey = await resolveCurrentStreamKey({
    workspaceId: input.workspaceId,
    streamId: input.keyStreamId,
    recipientKeyId: session.keyId,
    privateKey: session.privateKey,
  })
  if (!streamKey) {
    throw new Error("You don't have access to this encrypted scratchpad's key")
  }
  const { envelope, ciphertext } = await sealMessage({
    key: streamKey.key,
    keyGeneration: streamKey.keyGeneration,
    payload: input.note,
    aad: buildDecisionNoteAad({
      streamId: input.streamId,
      decisionId: input.decisionId,
      decidedBy: input.decidedBy,
    }),
  })
  return { ciphertext: bytesToBase64(ciphertext), envelope }
}

async function openSealed(
  ciphertext: string,
  rawEnvelope: unknown,
  expectedAad: string,
  opts: DecryptMessageOpts
): Promise<string | null> {
  const envelope = parseStreamEnvelope(rawEnvelope)
  if (!envelope || envelope.aad !== expectedAad) return null
  try {
    const ssk = await resolveStreamKey({
      workspaceId: opts.workspaceId,
      streamId: opts.rootStreamId ?? opts.streamId,
      keyGeneration: envelope.keyGeneration,
      recipientKeyId: opts.recipientKeyId,
      privateKey: opts.privateKey,
    })
    if (!ssk) return null
    return await openMessageAsString({ key: ssk, envelope, ciphertext: base64ToBytes(ciphertext) })
  } catch {
    return null
  }
}

function parseSealedDecisionContent(raw: string): SealedDecisionContent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const candidate = parsed as Partial<SealedDecisionContent>
  if (typeof candidate.title !== "string") return null
  if (candidate.bodyMarkdown !== undefined && typeof candidate.bodyMarkdown !== "string") return null
  const labels = candidate.optionLabels
  if (!labels || typeof labels !== "object") return null
  for (const label of Object.values(labels)) {
    if (typeof label !== "string") return null
  }
  return {
    title: candidate.title,
    ...(candidate.bodyMarkdown === undefined ? {} : { bodyMarkdown: candidate.bodyMarkdown }),
    optionLabels: labels as Record<string, string>,
  }
}
