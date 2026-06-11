import { ulid } from "ulid"
import {
  buildMessageAad,
  bytesToBase64,
  sealMessage,
  serializeSealedPayload,
  type SealedSourceItem,
} from "@threa/crypto"
import {
  AgentStepTypes,
  type AgentStepType,
  type SealedStep,
  type SealedStepStart,
  type EnclaveSealedSubstep,
  type TraceSource,
} from "@threa/types"
import {
  TraceProjector,
  type AgentEvent,
  type AgentObserver,
  type TraceStepFinalize,
  type TraceStepRecord,
  type TraceStepSink,
  type TraceSubstepEntry,
} from "@threa/agent-runtime/runtime"

/**
 * Observes the agent loop and ships each user-facing trace step back to the
 * backend, sealed under the stream's SSK — so the regional backend persists a
 * trace it can't read (INV-E7) and the owner's browser decrypts it exactly as
 * it decrypts message ciphertext.
 *
 * The event → step state machine is the shared `TraceProjector` — the exact
 * code the in-process companion runs — so the two surfaces cannot diverge on
 * which events become steps. Only the sink differs: each step's content is
 * sealed under the *reply* SSK (the current generation), bound by AAD to
 * `streamId|stepId|senderId` — the same message-AAD scheme, with the
 * enclave-minted `step_…` id in the id slot (no collision with `msg_…` ids)
 * so the server can't shuffle a step's ciphertext onto a different row.
 * Plaintext exists only here, for the duration of the loop, and is never
 * logged or persisted in the clear.
 *
 * Every step opens with a `step:started` (so a refresh / open trace dialog sees
 * the in-flight step and hangs its live substeps under it) and closes with the
 * finalized step:
 * - atomic steps (thinking, message_sent, …): started + finalized back-to-back,
 *   one seal serving both frames (content known up front)
 * - `tool:start` → `tool:progress`* → `tool:complete`/`tool:error`: the real
 *   in-flight window — started carries no content (the result isn't known yet),
 *   substeps stream the phase text, and the finalize seals the tool's result.
 * Hidden tools (trace.hidden) are skipped entirely (OTEL-only), same as the backend.
 */
export interface EnclaveTraceObserverDeps {
  streamId: string
  /** 32-byte SSK for `replyKeyGeneration` — the generation replies (and steps) seal under. */
  replySsk: Uint8Array
  replyKeyGeneration: number
  /** Ariadne's sender id, bound into each step's seal AAD. */
  senderId: string
  /** Open an in-flight step the moment the loop starts it (awaited, so it lands before the finalize). */
  sendStepStarted: (step: SealedStepStart) => Promise<void>
  /** Finalize a step in place once it completes (awaited, so steps land in order). */
  sendStep: (step: SealedStep) => Promise<void>
  /** Deliver one sealed substep — ephemeral mid-run phase text (e.g. research progress). */
  sendSubstep: (substep: EnclaveSealedSubstep) => Promise<void>
}

/** The sink's handle for an in-flight tool step: the enclave-minted step id its seals AAD-bind to. */
interface EnclaveOpenStep {
  stepId: string
}

/**
 * The enclave's sealing sink for the shared `TraceProjector`: every step the
 * projector emits is sealed under the reply SSK and shipped over the existing
 * `/steps` callbacks. Citation sources ride INSIDE the sealed payload — they
 * reveal what was researched, so they must never travel as a cleartext field
 * (E2EE-9/14). A sourceless step seals the bare content string, byte-identical
 * to a plain seal.
 */
class EnclaveSealingSink implements TraceStepSink<EnclaveOpenStep> {
  constructor(private readonly deps: EnclaveTraceObserverDeps) {}

  async record(step: TraceStepRecord): Promise<void> {
    // Content is known up front: open + finalize the same step back-to-back.
    // One seal, AAD-bound to this step's id, reused for both frames — so an
    // open trace dialog sees the content (and sources) the moment the step opens.
    const stepId = mintStepId()
    const sealed = await this.seal(
      serializeSealedPayload(step.content, undefined, toSealedSources(step.sources)),
      stepId
    )
    await this.openStep({ stepId, stepType: step.stepType, ...sealed })
    await this.deps.sendStep({
      stepId,
      stepType: step.stepType,
      ...sealed,
      ...(step.messageId !== undefined ? { messageId: step.messageId } : {}),
      ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
    })
  }

  async open(params: { stepType: AgentStepType }): Promise<EnclaveOpenStep> {
    // Open the in-flight step with no content (the result isn't known yet);
    // the minted id is the handle, so the finalize lands on the same row.
    const stepId = mintStepId()
    await this.openStep({ stepId, stepType: params.stepType })
    return { stepId }
  }

  async complete(step: EnclaveOpenStep, final: TraceStepFinalize): Promise<void> {
    const sealed = await this.seal(
      serializeSealedPayload(final.content, undefined, toSealedSources(final.sources)),
      step.stepId
    )
    await this.deps.sendStep({
      stepId: step.stepId,
      stepType: final.stepType,
      ...sealed,
      ...(final.messageId !== undefined ? { messageId: final.messageId } : {}),
      ...(final.durationMs !== undefined ? { durationMs: final.durationMs } : {}),
    })
  }

  async substep(params: {
    stepType: AgentStepType
    step: EnclaveOpenStep
    text: string
    snapshot: TraceSubstepEntry[]
  }): Promise<void> {
    // Mid-run phase text is derived from the encrypted prompt, so seal it under
    // the SSK like a step, AAD-bound to the in-flight step. Two sealed payloads
    // travel in one POST, mirroring the in-process emitSubstep + updateSubsteps:
    // the single new phase (ephemeral, drives the live "Ariadne is …" indicator)
    // and the running snapshot (persisted onto the step row so a refresh / open
    // mid-run replays it).
    const sealed = await this.seal(params.text, params.step.stepId)
    const snapshot = await this.seal(JSON.stringify({ substeps: params.snapshot }), params.step.stepId)
    await this.deps.sendSubstep({
      stepType: params.stepType,
      ...sealed,
      stepId: params.step.stepId,
      snapshotCiphertext: snapshot.ciphertext,
      snapshotEnvelope: snapshot.envelope,
    })
  }

  /**
   * Open an in-flight step — best-effort. The `step:started` frame is live-UX
   * only (it lets an open trace dialog render the in-progress step); the durable
   * record is the *finalize* (`sendStep`), which has its own persistence fallback.
   * So a failed/unsupported start POST must NOT abort the handler and drop the
   * finalize — swallow it. (This is why a backend missing the `/steps/started`
   * route still records every step, just without the live in-flight frame.)
   */
  private async openStep(step: SealedStepStart): Promise<void> {
    // Swallow both a rejected promise AND a synchronous throw — a bad
    // `sendStepStarted` must never abort the handler and drop the durable
    // finalize. `.catch()` alone misses a sync throw before the promise exists.
    try {
      await this.deps.sendStepStarted(step)
    } catch {
      // best-effort: the live `step:started` frame is UX-only (see above)
    }
  }

  /**
   * Seal one plaintext trace string under the reply SSK, AAD-bound to the step's
   * id (`streamId|stepId|senderId`) so the ciphertext can't be moved onto another
   * step row undetected — the same anti-shuffle binding messages use.
   */
  private async seal(
    content: string,
    stepId: string
  ): Promise<{ ciphertext: string; envelope: SealedStep["envelope"] }> {
    const sealed = await sealMessage({
      key: this.deps.replySsk,
      keyGeneration: this.deps.replyKeyGeneration,
      payload: content,
      aad: buildMessageAad({ streamId: this.deps.streamId, messageId: stepId, senderId: this.deps.senderId }),
    })
    return { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope }
  }
}

export class EnclaveTraceObserver implements AgentObserver {
  private readonly projector: TraceProjector<EnclaveOpenStep>

  constructor(deps: EnclaveTraceObserverDeps) {
    this.projector = new TraceProjector(new EnclaveSealingSink(deps))
  }

  async handle(event: AgentEvent): Promise<void> {
    await this.projector.handle(event)
  }

  /**
   * Emit the leading CONTEXT step — the enclave's equivalent of the in-process
   * persona-agent's CONTEXT_RECEIVED step ("Triggered by: …"). The runtime never
   * emits this for the initial trigger (only `context:received` for mid-turn new
   * messages), so the enclave's orchestration layer (run-turn) drives it once,
   * before the loop. The message body is the decrypted prompt, sealed under the
   * SSK exactly like a step; id/author/time are clear metadata. Content shape
   * matches the in-process step so the same frontend renderer applies.
   */
  async emitContext(trigger: {
    messageId: string
    authorName: string
    authorType: string
    createdAt: string
    content: string
  }): Promise<void> {
    await this.projector.record({
      stepType: AgentStepTypes.CONTEXT_RECEIVED,
      content: JSON.stringify({
        messages: [
          {
            messageId: trigger.messageId,
            authorName: trigger.authorName,
            authorType: trigger.authorType,
            createdAt: trigger.createdAt,
            content: trigger.content,
            isTrigger: true,
          },
        ],
      }),
    })
  }

  /**
   * Emit the trailing TURN_DIGEST step (C-1) — the enclave's twin of the
   * in-process post-run digest persist. Driven by run-turn after the loop ends
   * (the runtime never emits a digest event itself); the content is the digest
   * JSON, sealed under the SSK exactly like any step and shipped over the same
   * `/steps` callback, so the backend persists ciphertext it can't read and a
   * later assignment can ship it back as `recentDigests`.
   */
  async emitTurnDigest(content: string): Promise<void> {
    await this.projector.record({ stepType: AgentStepTypes.TURN_DIGEST, content })
  }
}

function mintStepId(): string {
  return `step_${ulid()}`
}

/**
 * Project the runtime's trace sources into the sealed-payload twin. The
 * sealed shape requires a `url` (it's what the renderer links) — the enclave's
 * web-only tools always produce one, so a url-less source (a workspace shape
 * the enclave can't emit today) is dropped rather than sealed un-renderable.
 * `domain` doesn't travel: the renderer derives it from the url, exactly like
 * the reply bubble's source list. Empty/absent input returns undefined so the
 * sealed bytes stay byte-identical to a sourceless step.
 */
function toSealedSources(sources: TraceSource[] | undefined): SealedSourceItem[] | undefined {
  const sealable = (sources ?? [])
    .filter((s): s is TraceSource & { url: string } => typeof s.url === "string" && s.url.length > 0)
    .map((s) => ({ type: s.type, title: s.title, url: s.url, ...(s.snippet ? { snippet: s.snippet } : {}) }))
  return sealable.length > 0 ? sealable : undefined
}
