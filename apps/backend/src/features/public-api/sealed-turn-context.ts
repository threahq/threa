import type { SealedTurnContext, EnclaveStreamEnvelope } from "@threa/types"
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

export function buildSealedTurnContext(inputs: BuildSealedTurnContextInputs): SealedTurnContext | null {
  const { e2e, bikKeyId, wraps, trigger, priorMessages } = inputs
  if (!trigger.ciphertext || !trigger.envelope) return null

  const botWraps = wraps.filter((w) => w.recipientKind === "bot")
  const currentGen = e2e.currentKeyGeneration
  const triggerGen = (trigger.envelope as EnclaveStreamEnvelope).keyGeneration
  const hasWrap = (generation: number) =>
    botWraps.some((w) => w.recipientKeyId === bikKeyId && w.keyGeneration === generation)

  // The claiming BIK must both open the prompt (its generation can lag `current`
  // if the stream rotated after the turn was stored) and seal the reply (under
  // `current`). The claim predicate already proved both against the same wraps
  // table; this re-check guards the revoke/rotation race between claim and build.
  if (!hasWrap(currentGen) || !hasWrap(triggerGen)) return null

  // Send every wrap addressed to the claiming BIK (all generations) so it can
  // also open older history; the bot skips any generation it has no wrap for.
  const chosenWraps = botWraps
    .filter((w) => w.recipientKeyId === bikKeyId)
    .map((w) => ({ keyGeneration: w.keyGeneration, wrapEnc: w.wrapEnc, wrapCt: w.wrapCt }))

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
    prompt: {
      ciphertext: trigger.ciphertext.toString("base64"),
      envelope: trigger.envelope as EnclaveStreamEnvelope,
    },
    reply: { keyGeneration: currentGen, senderId: inputs.replySenderId },
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
