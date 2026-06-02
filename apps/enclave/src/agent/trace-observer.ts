import { ulid } from "ulid"
import { buildMessageAad, bytesToBase64, sealMessage } from "@threa/crypto"
import {
  AgentStepTypes,
  type EnclaveSealedStep,
  type EnclaveSealedStepStart,
  type EnclaveSealedSubstep,
} from "@threa/types"
import type { AgentEvent, AgentObserver } from "@threa/agent-runtime/runtime"

/**
 * Observes the agent loop and ships each user-facing trace step back to the
 * backend, sealed under the stream's SSK — so the regional backend persists a
 * trace it can't read (INV-E7) and the owner's browser decrypts it exactly as
 * it decrypts message ciphertext.
 *
 * Each step's content is sealed under the *reply* SSK (the current generation),
 * bound by AAD to `streamId|stepId|senderId` — the same message-AAD scheme,
 * with the enclave-minted `step_…` id in the id slot (no collision with `msg_…`
 * ids) so the server can't shuffle a step's ciphertext onto a different row.
 * Plaintext exists only here, for the duration of the loop, and is never logged
 * or persisted in the clear.
 *
 * This mirrors the backend `SessionTraceObserver`'s event→step lifecycle exactly
 * — only the sink differs (seal + POST instead of DB + socket). Every step opens
 * with a `step:started` (so a refresh / open trace dialog sees the in-flight step
 * and hangs its live substeps under it) and closes with the finalized step:
 * - `thinking` / `message:sent`: started + finalized back-to-back (content known up front)
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
  sendStepStarted: (step: EnclaveSealedStepStart) => Promise<void>
  /** Finalize a step in place once it completes (awaited, so steps land in order). */
  sendStep: (step: EnclaveSealedStep) => Promise<void>
  /** Deliver one sealed substep — ephemeral mid-run phase text (e.g. research progress). */
  sendSubstep: (substep: EnclaveSealedSubstep) => Promise<void>
}

export class EnclaveTraceObserver implements AgentObserver {
  /** Maps an in-flight tool call to the step id minted at tool:start, so completion finalizes the same row. */
  private readonly stepIdByToolCallId = new Map<string, string>()
  /** Running substep log per in-flight tool call — sealed and persisted on each progress so a refresh replays it. */
  private readonly substepsByToolCallId = new Map<string, Array<{ text: string; at: string }>>()
  /** Tool calls hidden at tool:start — distinguishes "hidden, skip" from "unknown, synthesize error step". */
  private readonly hiddenToolCallIds = new Set<string>()

  constructor(private readonly deps: EnclaveTraceObserverDeps) {}

  async handle(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "thinking": {
        // Content is known up front: open + finalize the same step back-to-back,
        // mirroring the backend's startStep(content) → complete(). One seal,
        // AAD-bound to this step's id, reused for both the start and the finalize.
        const stepId = mintStepId()
        const sealed = await this.seal(event.content, stepId)
        await this.deps.sendStepStarted({ stepId, stepType: AgentStepTypes.THINKING, ...sealed })
        await this.deps.sendStep({ stepId, stepType: AgentStepTypes.THINKING, ...sealed, durationMs: event.durationMs })
        return
      }

      case "tool:start": {
        // Hidden tools are recorded in OTEL but never surface in the trace.
        if (event.hidden) {
          this.hiddenToolCallIds.add(event.toolCallId)
          return
        }
        // Open the in-flight step with no content (the result isn't known yet);
        // cache the minted id so tool:complete/tool:error finalizes the same row.
        const stepId = mintStepId()
        this.stepIdByToolCallId.set(event.toolCallId, stepId)
        this.substepsByToolCallId.set(event.toolCallId, [])
        await this.deps.sendStepStarted({ stepId, stepType: event.stepType })
        return
      }

      case "tool:progress": {
        // Mid-run phase text (e.g. the research sub-agent's "Searching the web: …").
        // Derived from the encrypted prompt, so seal it under the SSK like a step.
        // Two sealed payloads travel in one POST, mirroring the unencrypted
        // observer's emitSubstep + updateSubsteps: the single new phase (ephemeral,
        // drives the live "Ariadne is …" indicator) and the running snapshot
        // (persisted onto the step row so a refresh / open mid-run replays it).
        const text = event.substep?.trim()
        if (!text) return
        const stepId = this.stepIdByToolCallId.get(event.toolCallId)
        // Bind the seal AAD to the in-flight step (fall back to a fresh id only when
        // there's no opened step to bind to — a hidden/never-started tool).
        const sealed = await this.seal(text, stepId ?? mintStepId())
        const log = this.substepsByToolCallId.get(event.toolCallId)
        let snapshot: { ciphertext: string; envelope: EnclaveSealedStep["envelope"] } | undefined
        if (stepId && log) {
          log.push({ text, at: new Date().toISOString() })
          snapshot = await this.seal(JSON.stringify({ substeps: [...log] }), stepId)
        }
        await this.deps.sendSubstep({
          stepType: event.stepType,
          ...sealed,
          stepId,
          snapshotCiphertext: snapshot?.ciphertext,
          snapshotEnvelope: snapshot?.envelope,
        })
        return
      }

      case "tool:complete": {
        const stepId = this.stepIdByToolCallId.get(event.toolCallId)
        // Clear all per-tool-call state up front (matches SessionTraceObserver,
        // which deletes the hidden marker on complete too) so nothing leaks.
        this.stepIdByToolCallId.delete(event.toolCallId)
        this.substepsByToolCallId.delete(event.toolCallId)
        this.hiddenToolCallIds.delete(event.toolCallId)
        if (!stepId) return // hidden tool — no step row was opened
        const sealed = await this.seal(event.trace.content, stepId)
        await this.deps.sendStep({ stepId, stepType: event.trace.stepType, ...sealed, durationMs: event.durationMs })
        return
      }

      case "tool:error": {
        const content = `${event.toolName} failed: ${event.error}`
        const cachedId = this.stepIdByToolCallId.get(event.toolCallId)
        if (cachedId) {
          // Finalize the in-flight step with the error.
          this.stepIdByToolCallId.delete(event.toolCallId)
          this.substepsByToolCallId.delete(event.toolCallId)
          const sealed = await this.seal(content, cachedId)
          await this.deps.sendStep({
            stepId: cachedId,
            stepType: AgentStepTypes.TOOL_ERROR,
            ...sealed,
            durationMs: event.durationMs,
          })
        } else if (!this.hiddenToolCallIds.has(event.toolCallId)) {
          // Unknown tool: the runtime emits tool:error with no preceding tool:start.
          // Synthesize a started + finalized error step so it's still visible.
          const stepId = mintStepId()
          const sealed = await this.seal(content, stepId)
          await this.deps.sendStepStarted({ stepId, stepType: AgentStepTypes.TOOL_ERROR, ...sealed })
          await this.deps.sendStep({
            stepId,
            stepType: AgentStepTypes.TOOL_ERROR,
            ...sealed,
            durationMs: event.durationMs,
          })
        }
        this.hiddenToolCallIds.delete(event.toolCallId)
        return
      }

      case "message:sent": {
        const stepId = mintStepId()
        const sealed = await this.seal(event.content, stepId)
        await this.deps.sendStepStarted({ stepId, stepType: AgentStepTypes.MESSAGE_SENT, ...sealed })
        await this.deps.sendStep({
          stepId,
          stepType: AgentStepTypes.MESSAGE_SENT,
          messageId: event.messageId,
          ...sealed,
        })
        return
      }
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
