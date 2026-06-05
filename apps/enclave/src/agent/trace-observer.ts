import { ulid } from "ulid"
import { buildMessageAad, bytesToBase64, sealMessage } from "@threa/crypto"
import {
  AgentStepTypes,
  type EnclaveSealedStep,
  type EnclaveSealedStepStart,
  type EnclaveSealedSubstep,
} from "@threa/types"
import type { AgentEvent, AgentObserver, TraceStepHandle, TraceStepSink } from "@threa/agent-runtime/runtime"
import { TraceMapper } from "@threa/agent-runtime/runtime"

/**
 * Observes the agent loop and ships each user-facing trace step back to the
 * backend, sealed under the stream's SSK — so the regional backend persists a
 * trace it can't read (INV-E7) and the owner's browser decrypts it exactly as
 * it decrypts message ciphertext.
 *
 * The event→step lifecycle is the shared `TraceMapper` — the *same* state
 * machine the backend's SessionTraceObserver runs, so the two traces cannot
 * drift on which events they handle or what step content they persist. This
 * file only supplies the sink: seal + POST instead of DB + socket.
 *
 * Each step's content is sealed under the *reply* SSK (the current generation),
 * bound by AAD to `streamId|stepId|senderId` — the same message-AAD scheme,
 * with the enclave-minted `step_…` id in the id slot (no collision with `msg_…`
 * ids) so the server can't shuffle a step's ciphertext onto a different row.
 * Plaintext exists only here, for the duration of the loop, and is never logged
 * or persisted in the clear.
 *
 * Every step opens with a `step:started` (so a refresh / open trace dialog sees
 * the in-flight step and hangs its live substeps under it) and closes with the
 * finalized step. When the finalize carries no new content (thinking,
 * reconsider/context steps), the seal produced at open is reused — one seal per
 * step, not two.
 */
export interface EnclaveTraceObserverDeps {
  streamId: string
  /** 32-byte SSK for `replyKeyGeneration` — the generation replies (and steps) seal under. */
  replySsk: Uint8Array
  replyKeyGeneration: number
  /** Ariadne's sender id, bound into each step's seal AAD. */
  senderId: string
  /** Open an in-flight step the moment the loop starts it (awaited, so it lands before the finalize). */
  sendStepStarted: (step: EnclaveSealedStepStart) => Promise<void>
  /** Finalize a step in place once it completes (awaited, so steps land in order). */
  sendStep: (step: EnclaveSealedStep) => Promise<void>
  /** Deliver one sealed substep — ephemeral mid-run phase text (e.g. research progress). */
  sendSubstep: (substep: EnclaveSealedSubstep) => Promise<void>
}

export class EnclaveTraceObserver implements AgentObserver {
  private readonly mapper: TraceMapper
  private readonly sink: EnclaveSealingStepSink

  constructor(deps: EnclaveTraceObserverDeps) {
    this.sink = new EnclaveSealingStepSink(deps)
    this.mapper = new TraceMapper(this.sink)
  }

  async handle(event: AgentEvent): Promise<void> {
    await this.mapper.handle(event)
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
    const step = await this.sink.openStep({
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
    await step.finalize({ stepType: AgentStepTypes.CONTEXT_RECEIVED })
  }
}

/**
 * The sealing sink: mints a `step_…` id per opened step, seals every payload
 * under the reply SSK AAD-bound to that id, and POSTs the started / finalized /
 * substep frames to the backend session callbacks.
 */
class EnclaveSealingStepSink implements TraceStepSink {
  constructor(private readonly deps: EnclaveTraceObserverDeps) {}

  async openStep(op: Parameters<TraceStepSink["openStep"]>[0]): Promise<TraceStepHandle> {
    const stepId = mintStepId()
    // Seal once when the content is known up front; the finalize reuses it
    // unless it carries different content (tool results arrive at finalize).
    const opened =
      op.content !== undefined ? { plaintext: op.content, sealed: await this.seal(op.content, stepId) } : undefined

    // The `step:started` frame is live-UX only (it lets an open trace dialog
    // render the in-progress step); the durable record is the *finalize*,
    // which has its own persistence fallback. So a failed/unsupported start
    // POST must NOT abort the handler and drop the finalize — swallow it.
    // (This is why a backend missing the `/steps/started` route still records
    // every step, just without the live in-flight frame.)
    try {
      await this.deps.sendStepStarted({ stepId, stepType: op.stepType, ...opened?.sealed })
    } catch {
      // best-effort: the live `step:started` frame is UX-only (see above)
    }

    return {
      substep: async ({ stepType, text, snapshot }) => {
        // Mid-run phase text is derived from the encrypted prompt, so seal it
        // under the SSK like a step. Two sealed payloads travel in one POST:
        // the single new phase (ephemeral, drives the live "Ariadne is …"
        // indicator) and the running snapshot (persisted onto the step row so
        // a refresh / open mid-run replays it).
        const sealed = await this.seal(text, stepId)
        const snapshotSealed = await this.seal(JSON.stringify({ substeps: snapshot }), stepId)
        await this.deps.sendSubstep({
          stepType,
          ...sealed,
          stepId,
          snapshotCiphertext: snapshotSealed.ciphertext,
          snapshotEnvelope: snapshotSealed.envelope,
        })
      },
      finalize: async (fin) => {
        let sealed: { ciphertext: string; envelope: EnclaveSealedStep["envelope"] }
        if (opened && (fin.content === undefined || fin.content === opened.plaintext)) {
          sealed = opened.sealed
        } else if (fin.content !== undefined) {
          sealed = await this.seal(fin.content, stepId)
        } else {
          // Can't finalize a contentless step that was also opened contentless —
          // the mapper never does this; fail loudly rather than seal "".
          throw new Error(`Enclave step ${stepId} (${fin.stepType}) finalized without content`)
        }
        await this.deps.sendStep({
          stepId,
          stepType: fin.stepType,
          ...sealed,
          durationMs: fin.durationMs,
          messageId: fin.messageId,
        })
      },
    }
  }

  async emitDetachedSubstep(sub: Parameters<TraceStepSink["emitDetachedSubstep"]>[0]): Promise<void> {
    // No opened step to bind to (hidden tool) — broadcast the phase text alone,
    // sealed under a fresh id, with no snapshot (there is no step row to replay
    // it onto).
    const sealed = await this.seal(sub.text, mintStepId())
    await this.deps.sendSubstep({ stepType: sub.stepType, ...sealed, stepId: undefined })
  }

  /**
   * Seal one plaintext trace string under the reply SSK, AAD-bound to the step's
   * id (`streamId|stepId|senderId`) so the ciphertext can't be moved onto another
   * step row undetected — the same anti-shuffle binding messages use.
   */
  private async seal(
    content: string,
    stepId: string
  ): Promise<{ ciphertext: string; envelope: EnclaveSealedStep["envelope"] }> {
    const sealed = await sealMessage({
      key: this.deps.replySsk,
      keyGeneration: this.deps.replyKeyGeneration,
      payload: content,
      aad: buildMessageAad({ streamId: this.deps.streamId, messageId: stepId, senderId: this.deps.senderId }),
    })
    return { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope }
  }
}

function mintStepId(): string {
  return `step_${ulid()}`
}
