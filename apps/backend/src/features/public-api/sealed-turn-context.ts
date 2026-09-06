import type { InvocationInputUpdateWire, SealedTurnContext, EnclaveStreamEnvelope } from "@threahq/types"
import type { E2eStream, StreamE2eKeyWrap } from "../e2e-streams"
import type { Message } from "../messaging"

/**
 * Builds the {@link SealedTurnContext} the bot claim endpoint hands an
 * owner-granted external runner when the delivery verdict is `sealed` — the
 * external analog of `buildEnclaveSessionAssignment`. Pure, so the
 * wrap-coverage and history-mapping logic is unit-testable without a DB; the
 * claim handler fetches the inputs, creates the session row with the callback
 * binding, and returns the result on the claim response.
 *
 * The backend never decrypts: it ships ciphertext + the SSK wraps addressed to
 * the claiming bot's BIK, and the bot unwraps with its identity private key.
 * Returns `null` when the turn can't be served (the claiming key can't cover the
 * prompt's and reply's generations — a revoke/rotation race after the claim
 * predicate passed), so the caller fails the claim loudly rather than handing
 * over a context the bot can't open.
 */
export interface BuildSealedTurnContextInputs {
  e2e: E2eStream
  /** The claiming bot instance's BIK key id — the assignment seals to this key. */
  bikKeyId: string
  /** All SSK wraps for the stream (any recipient kind); bot wraps for `bikKeyId` are filtered out here. */
  wraps: StreamE2eKeyWrap[]
  /** The triggering message (its ciphertext becomes the prompt). */
  trigger: Message
  /**
   * Display name of the trigger's author, for the bot's "Triggered by" context
   * step. Omitted when the author can't be resolved — the bot then suppresses
   * the row rather than rendering a misleading placeholder.
   */
  triggerAuthorName?: string
  /** Prior messages, oldest→newest, for context. */
  priorMessages: Message[]
  /** The bot id the replies are authored by + bound to in their seal AAD. */
  replySenderId: string
  /** Claim-minted secret the bot echoes on every sealed callback (model A). */
  callbackToken: string
}

export interface BuildSealedInputUpdateInputs {
  e2e: E2eStream
  bikKeyId: string
  wraps: StreamE2eKeyWrap[]
  trigger: Pick<Message, "ciphertext" | "envelope">
  replySenderId: string
  sourceRevision: number
}

export function buildSealedInputUpdate(
  inputs: BuildSealedInputUpdateInputs
): Extract<InvocationInputUpdateWire, { delivery: "sealed" }> | null {
  const { e2e, bikKeyId, wraps, trigger } = inputs
  if (!trigger.ciphertext || !trigger.envelope) return null
  const triggerGeneration = (trigger.envelope as EnclaveStreamEnvelope).keyGeneration
  const requiredGenerations = new Set([triggerGeneration, e2e.currentKeyGeneration])
  const chosen = wraps.filter(
    (wrap) =>
      wrap.recipientKind === "bot" && wrap.recipientKeyId === bikKeyId && requiredGenerations.has(wrap.keyGeneration)
  )
  if ([...requiredGenerations].some((generation) => !chosen.some((wrap) => wrap.keyGeneration === generation)))
    return null
  return {
    delivery: "sealed",
    sourceRevision: inputs.sourceRevision,
    prompt: { ciphertext: trigger.ciphertext.toString("base64"), envelope: trigger.envelope as EnclaveStreamEnvelope },
    wraps: chosen.map((wrap) => ({ keyGeneration: wrap.keyGeneration, wrapEnc: wrap.wrapEnc, wrapCt: wrap.wrapCt })),
    reply: { keyGeneration: e2e.currentKeyGeneration, senderId: inputs.replySenderId },
  }
}

export function buildSealedTurnContext(inputs: BuildSealedTurnContextInputs): SealedTurnContext | null {
  const { e2e, bikKeyId, wraps, trigger, priorMessages } = inputs
  const update = buildSealedInputUpdate({
    e2e,
    bikKeyId,
    wraps,
    trigger,
    replySenderId: inputs.replySenderId,
    sourceRevision: 0,
  })
  if (!update) return null
  // History spans older key generations; the update's wraps cover only trigger + current.
  const chosenWraps = wraps
    .filter((wrap) => wrap.recipientKind === "bot" && wrap.recipientKeyId === bikKeyId)
    .map((wrap) => ({ keyGeneration: wrap.keyGeneration, wrapEnc: wrap.wrapEnc, wrapCt: wrap.wrapCt }))

  const history = priorMessages
    .filter((m) => m.ciphertext && m.envelope)
    .map((m) => ({
      ciphertext: m.ciphertext!.toString("base64"),
      envelope: m.envelope as EnclaveStreamEnvelope,
      role: m.authorId === inputs.replySenderId ? ("assistant" as const) : ("user" as const),
      sequence: m.sequence.toString(),
    }))

  return {
    callbackToken: inputs.callbackToken,
    wraps: chosenWraps,
    history,
    prompt: update.prompt,
    reply: update.reply,
    ...(inputs.triggerAuthorName
      ? {
          trigger: {
            messageId: trigger.id,
            authorName: inputs.triggerAuthorName,
            authorType: trigger.authorType,
            createdAt: trigger.createdAt.toISOString(),
          },
        }
      : {}),
  }
}
