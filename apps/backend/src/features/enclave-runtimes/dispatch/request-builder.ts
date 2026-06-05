import type { EnclaveSessionAssignment, EnclaveStreamEnvelope } from "@threa/types"
import type { E2eStream, E2eStreamActor, StreamE2eKeyWrap } from "../../e2e-streams"
import type { Message } from "../../messaging"
import type { EnclaveRuntime } from "../repository"

/**
 * Builds the session assignment the backend hands to the enclave — pure, so the
 * recipient-selection and history-mapping logic is unit-testable without a DB.
 * The worker fetches the inputs, creates the session row, and POSTs the result.
 *
 * The backend never decrypts: it ships ciphertext + the SSK wraps addressed to
 * the chosen live EIK, and the enclave unwraps with its private key. Returns
 * `null` when there's nothing to dispatch (no enclave actor, or no live enclave
 * that can decrypt the current generation) — the caller then no-ops.
 */

export interface PersonaInvokeConfig {
  systemPrompt: string
  /** May carry the `openrouter:` provider prefix; stripped to the bare model id. */
  model: string
  temperature: number | null
  maxTokens: number | null
}

export interface BuildInvokeInputs {
  e2e: E2eStream
  actors: E2eStreamActor[]
  liveEiks: EnclaveRuntime[]
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
  /**
   * Opaque ciphertext for each E2E attachment bound to the trigger message,
   * base64-encoded. The worker reads these from S3 (the backend can't decrypt
   * them); the enclave matches them to the decrypted `attachmentRefs` by id and
   * opens them with the sealed per-file key. Empty/omitted → no attachments.
   */
  attachmentCiphertexts?: { attachmentId: string; ciphertext: string }[]
  /** Ask the enclave to generate + seal a title for this (untitled) scratchpad. */
  autoTitle?: boolean
}

export interface BuiltEnclaveInvoke {
  instanceUrl: string
  /** The chosen EIK's keyId — stored as the session's owning server (`server_id`). */
  keyId: string
  assignment: EnclaveSessionAssignment
}

export function buildEnclaveSessionAssignment(inputs: BuildInvokeInputs): BuiltEnclaveInvoke | null {
  const { e2e, actors, liveEiks, wraps, trigger, priorMessages, persona } = inputs

  if (!actors.some((a) => a.kind === "enclave")) return null
  if (!trigger.ciphertext || !trigger.envelope) return null

  const enclaveWraps = wraps.filter((w) => w.recipientKind === "enclave")
  const currentGen = e2e.currentKeyGeneration
  const triggerGen = (trigger.envelope as EnclaveStreamEnvelope).keyGeneration
  const hasWrap = (keyId: string, generation: number) =>
    enclaveWraps.some((w) => w.recipientKeyId === keyId && w.keyGeneration === generation)

  // The chosen EIK must both *open the prompt* (its generation can lag `current`
  // if the stream rotated after the turn was stored) and *seal the reply* (under
  // `current`). Requiring both avoids picking a key that can do one but not the
  // other, which would surface as a late enclave failure.
  const chosen = liveEiks.find((eik) => hasWrap(eik.keyId, currentGen) && hasWrap(eik.keyId, triggerGen))
  if (!chosen) return null

  // Send every wrap addressed to the chosen EIK (all generations) so it can also
  // open older history; the enclave skips any generation it has no wrap for.
  const chosenWraps = enclaveWraps
    .filter((w) => w.recipientKeyId === chosen.keyId)
    .map((w) => ({ keyGeneration: w.keyGeneration, wrapEnc: w.wrapEnc, wrapCt: w.wrapCt }))

  const history = priorMessages
    .filter((m) => m.ciphertext && m.envelope)
    .map((m) => ({
      ciphertext: m.ciphertext!.toString("base64"),
      envelope: m.envelope as EnclaveStreamEnvelope,
      role: m.authorType === "persona" ? ("assistant" as const) : ("user" as const),
    }))

  const assignment: EnclaveSessionAssignment = {
    sessionId: inputs.sessionId,
    streamId: e2e.streamId,
    wraps: chosenWraps,
    history,
    prompt: {
      ciphertext: trigger.ciphertext.toString("base64"),
      envelope: trigger.envelope as EnclaveStreamEnvelope,
    },
    // The worker assembles the full system prompt via the shared
    // `buildEnclaveSystemPrompt` and passes it through here as `systemPrompt`.
    system: persona.systemPrompt,
    model: persona.model.replace(/^openrouter:/, ""),
    ...(persona.temperature !== null ? { temperature: persona.temperature } : {}),
    ...(persona.maxTokens !== null ? { maxTokens: persona.maxTokens } : {}),
    // Per-stream tool-privacy policy: ship it so the enclave gates its tools.
    // NULL = unrestricted → omit the field (the enclave then builds its full
    // web surface, today's behavior).
    ...(e2e.allowedToolCategories ? { allowedToolCategories: e2e.allowedToolCategories } : {}),
    // Attachment ciphertext (trigger + recent history), shipped inline so the
    // enclave reads files without an S3 egress. Omitted when there are none.
    ...(inputs.attachmentCiphertexts && inputs.attachmentCiphertexts.length > 0
      ? { attachmentCiphertexts: inputs.attachmentCiphertexts }
      : {}),
    ...(inputs.autoTitle ? { autoTitle: true } : {}),
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

  return { instanceUrl: chosen.instanceUrl, keyId: chosen.keyId, assignment }
}
