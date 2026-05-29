import type { EnclaveInvokeRequest, EnclaveStreamEnvelope } from "@threa/types"
import type { E2eStream, E2eStreamActor, StreamE2eKeyWrap } from "../../e2e-streams"
import type { Message } from "../../messaging"
import type { EnclaveRuntime } from "../repository"

/**
 * Builds the `/invoke` request the backend forwards to the enclave — pure, so
 * the recipient-selection and history-mapping logic is unit-testable without a
 * DB. The worker fetches the inputs and POSTs the result.
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
  /** Prior messages, oldest→newest, for context. */
  priorMessages: Message[]
  persona: PersonaInvokeConfig
  /** Server-minted id the reply is sealed under and stored as. */
  replyMessageId: string
  /** The persona id the reply is authored by (Ariadne). */
  replySenderId: string
}

export interface BuiltEnclaveInvoke {
  instanceUrl: string
  request: EnclaveInvokeRequest
}

export function buildEnclaveInvokeRequest(inputs: BuildInvokeInputs): BuiltEnclaveInvoke | null {
  const { e2e, actors, liveEiks, wraps, trigger, priorMessages, persona } = inputs

  if (!actors.some((a) => a.kind === "enclave")) return null
  if (!trigger.ciphertext || !trigger.envelope) return null

  const enclaveWraps = wraps.filter((w) => w.recipientKind === "enclave")
  const currentGen = e2e.currentKeyGeneration

  // Pick a live EIK that can decrypt the *current* generation (has a wrap for
  // it) — without that, it can't open the prompt or seal the reply.
  const chosen = liveEiks.find((eik) =>
    enclaveWraps.some((w) => w.recipientKeyId === eik.keyId && w.keyGeneration === currentGen)
  )
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

  const request: EnclaveInvokeRequest = {
    streamId: e2e.streamId,
    wraps: chosenWraps,
    history,
    prompt: {
      ciphertext: trigger.ciphertext.toString("base64"),
      envelope: trigger.envelope as EnclaveStreamEnvelope,
    },
    system: persona.systemPrompt,
    model: persona.model.replace(/^openrouter:/, ""),
    ...(persona.temperature !== null ? { temperature: persona.temperature } : {}),
    ...(persona.maxTokens !== null ? { maxTokens: persona.maxTokens } : {}),
    reply: { keyGeneration: currentGen, messageId: inputs.replyMessageId, senderId: inputs.replySenderId },
  }

  return { instanceUrl: chosen.instanceUrl, request }
}
