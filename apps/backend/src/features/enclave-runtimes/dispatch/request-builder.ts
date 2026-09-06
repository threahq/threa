import type {
  EnclaveNamingInstruction,
  EnclaveSessionAssignment,
  EnclaveStreamEnvelope,
  ToolPrivacyPolicy,
} from "@threahq/types"
import type { E2eStream, E2eStreamActor, StreamE2eKeyWrap } from "../../e2e-streams"
import type { Message } from "../../messaging"

/**
 * Builds the session assignment the claim endpoint hands to the enclave —
 * pure, so the wrap-coverage and history-mapping logic is unit-testable
 * without a DB. The claim service fetches the inputs, creates the session
 * row, and returns the result as the claim response.
 *
 * The backend never decrypts: it ships ciphertext + the SSK wraps addressed
 * to the claiming EIK, and the enclave unwraps with its private key. Returns
 * `null` when the turn can't be served (no enclave actor, or the claiming key
 * can't cover the needed generations — a revoke/rotation race after the claim
 * predicate passed) — the caller then fails the claim loudly.
 */

export interface PersonaInvokeConfig {
  /** The stable half of the prompt — what the enclave's cache breakpoint covers. */
  systemPrompt: string
  /** The per-turn half, kept outside the cached prefix. */
  systemVolatilePrompt: string
  /** May carry the `openrouter:` provider prefix; stripped to the bare model id. */
  model: string
  temperature: number | null
  maxTokens: number | null
}

export interface BuildInvokeInputs {
  e2e: E2eStream
  actors: E2eStreamActor[]
  /** The claiming instance's EIK key id — the assignment seals to this key. */
  eikKeyId: string
  /** All SSK wraps for the stream (any recipient kind); enclave wraps are filtered out here. */
  wraps: StreamE2eKeyWrap[]
  /** The triggering user message (its ciphertext becomes the prompt). */
  trigger: Message
  /**
   * Display name of the trigger's author, for the enclave's CONTEXT trace step.
   * Omitted when the author can't be resolved — the enclave then suppresses the
   * "Triggered by" row rather than rendering a misleading placeholder.
   */
  triggerAuthorName?: string
  /** Prior messages, oldest→newest, for context. */
  priorMessages: Message[]
  persona: PersonaInvokeConfig
  /** The persona id the replies are authored by + bound to in their seal AAD (Ariadne). */
  replySenderId: string
  /** The server-created agent_sessions id the enclave drives this turn under. */
  sessionId: string
  /** Claim-minted secret the enclave echoes on every session callback (Phase 2.4b, E2EE-21). */
  callbackToken: string
  /**
   * The stream's tool-privacy policy (from `stream_policies`, resolved at the
   * root scratchpad — threads inherit). `null` = no restriction. Shipped on the
   * assignment so the enclave gates its own toolset; the server never builds
   * the tools itself.
   */
  allowedToolCategories: ToolPrivacyPolicy
  /**
   * Opaque ciphertext for each E2E attachment bound to the trigger message,
   * base64-encoded. The claim service reads these from S3 (the backend can't
   * decrypt them); the enclave matches them to the decrypted `attachmentRefs`
   * by id and opens them with the sealed per-file key. Empty/omitted → no
   * attachments.
   */
  attachmentCiphertexts?: { attachmentId: string; ciphertext: string }[]
  /** Revision-fenced dynamic naming work reserved by the session transaction. */
  naming?: EnclaveNamingInstruction
  /**
   * Sealed `turn_digest` step ciphertext from the stream's recent completed
   * sessions, oldest→newest (C-1). Opaque to the backend — the enclave opens
   * what its wraps allow and folds the digests into the turn's system context.
   * `completedAt` is clear timing metadata (the step row already exposes it).
   */
  recentDigests?: { ciphertext: string; envelope: EnclaveStreamEnvelope; completedAt: string }[]
  /**
   * Char budget for the enclave's verbatim window (C-2). The enclave fills
   * history newest-first up to this and folds the overflow into the rolling
   * summary; omitted → it keeps the whole shipped window verbatim.
   */
  maxChars?: number
  /**
   * The stream's prior sealed rolling summary, if any — opaque ciphertext the
   * enclave opens with its SSK wrap, folds the overflow into, and re-seals.
   */
  priorSummary?: { ciphertext: string; envelope: EnclaveStreamEnvelope }
  /**
   * The prior summary's `last_summarized_sequence` (base-10) — the highest
   * sequence already folded, so the enclave only summarizes newer history.
   */
  summaryCursor?: string
}

export function buildEnclaveSessionAssignment(inputs: BuildInvokeInputs): EnclaveSessionAssignment | null {
  const { e2e, actors, eikKeyId, wraps, trigger, priorMessages, persona } = inputs

  if (!actors.some((a) => a.kind === "enclave")) return null
  if (!trigger.ciphertext || !trigger.envelope) return null

  const enclaveWraps = wraps.filter((w) => w.recipientKind === "enclave")
  const currentGen = e2e.currentKeyGeneration
  const triggerGen = (trigger.envelope as EnclaveStreamEnvelope).keyGeneration
  const hasWrap = (generation: number) =>
    enclaveWraps.some((w) => w.recipientKeyId === eikKeyId && w.keyGeneration === generation)

  // The claiming EIK must both *open the prompt* (its generation can lag
  // `current` if the stream rotated after the turn was stored) and *seal the
  // reply* (under `current`). The claim predicate already proved both against
  // the same wraps table; this re-check guards the revoke/rotation race
  // between claim and build.
  if (!hasWrap(currentGen) || !hasWrap(triggerGen)) return null

  // Send every wrap addressed to the claiming EIK (all generations) so it can
  // also open older history; the enclave skips any generation it has no wrap for.
  const chosenWraps = enclaveWraps
    .filter((w) => w.recipientKeyId === eikKeyId)
    .map((w) => ({ keyGeneration: w.keyGeneration, wrapEnc: w.wrapEnc, wrapCt: w.wrapCt }))

  const history = priorMessages
    .filter((m) => m.ciphertext && m.envelope)
    .map((m) => ({
      ciphertext: m.ciphertext!.toString("base64"),
      envelope: m.envelope as EnclaveStreamEnvelope,
      role: m.authorType === "persona" ? ("assistant" as const) : ("user" as const),
      // Clear metadata: the message's stream sequence, so the enclave can advance
      // the rolling summary cursor over the messages it folds (C-2).
      sequence: m.sequence.toString(),
    }))

  return {
    sessionId: inputs.sessionId,
    callbackToken: inputs.callbackToken,
    streamId: e2e.streamId,
    wraps: chosenWraps,
    history,
    prompt: {
      ciphertext: trigger.ciphertext.toString("base64"),
      envelope: trigger.envelope as EnclaveStreamEnvelope,
    },
    // The claim service assembles the full system prompt via the shared
    // `buildEnclaveSystemPrompt` and passes it through here as `systemPrompt`.
    system: persona.systemPrompt,
    ...(persona.systemVolatilePrompt ? { systemVolatile: persona.systemVolatilePrompt } : {}),
    model: persona.model.replace(/^openrouter:/, ""),
    ...(persona.temperature !== null ? { temperature: persona.temperature } : {}),
    ...(persona.maxTokens !== null ? { maxTokens: persona.maxTokens } : {}),
    // Per-stream tool-privacy policy: ship it so the enclave gates its tools.
    // NULL = unrestricted → omit the field (the enclave then builds its full
    // web surface).
    ...(inputs.allowedToolCategories ? { allowedToolCategories: inputs.allowedToolCategories } : {}),
    // Attachment ciphertext (trigger + recent history), shipped inline so the
    // enclave reads files without an S3 egress. Omitted when there are none.
    ...(inputs.attachmentCiphertexts && inputs.attachmentCiphertexts.length > 0
      ? { attachmentCiphertexts: inputs.attachmentCiphertexts }
      : {}),
    ...(inputs.naming ? { naming: inputs.naming } : {}),
    // Prior turns' sealed digests (C-1) — shipped only when present so the
    // no-digest assignment stays byte-identical to before.
    ...(inputs.recentDigests && inputs.recentDigests.length > 0 ? { recentDigests: inputs.recentDigests } : {}),
    // Deepened verbatim window + rolling summary (C-2). Each field is shipped
    // only when present so a stream with no prior summary / no budget stays
    // byte-identical to before.
    ...(inputs.maxChars !== undefined ? { maxChars: inputs.maxChars } : {}),
    ...(inputs.priorSummary ? { priorSummary: inputs.priorSummary } : {}),
    ...(inputs.summaryCursor !== undefined ? { summaryCursor: inputs.summaryCursor } : {}),
    reply: { keyGeneration: currentGen, senderId: inputs.replySenderId },
    // Clear metadata for the enclave's "Triggered by" CONTEXT step; the body is
    // the decrypted prompt, sealed enclave-side. Omitted when the author name
    // can't be resolved, so the enclave suppresses the row instead of rendering
    // a misleading placeholder.
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
