import { ulid } from "ulid"
import { buildMessageAad, bytesToBase64, sealMessage } from "@threa/crypto"
import { AgentStepTypes, type EnclaveSealedStep } from "@threa/types"
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
 * ids). Plaintext exists only here, for the duration of the loop, and is never
 * logged or persisted in the clear.
 *
 * This mirrors the backend `SessionTraceObserver`'s event→step mapping for the
 * events the enclave loop emits: the LLM's reasoning (`thinking`), each completed
 * tool call (`tool:complete` → its trace step type, e.g. web_search / visit_page
 * / research) or failure (`tool:error`), and each reply (`message:sent`). The
 * enclave seals append-only, so it maps the *terminal* tool events (not the
 * tool:start/progress lifecycle the backend uses for in-place step updates).
 */
export interface EnclaveTraceObserverDeps {
  streamId: string
  /** 32-byte SSK for `replyKeyGeneration` — the generation replies (and steps) seal under. */
  replySsk: Uint8Array
  replyKeyGeneration: number
  /** Ariadne's sender id, bound into each step's seal AAD. */
  senderId: string
  /** Deliver one sealed step to the backend the moment it's produced (awaited, so steps land in order). */
  sendStep: (step: EnclaveSealedStep) => Promise<void>
}

export class EnclaveTraceObserver implements AgentObserver {
  constructor(private readonly deps: EnclaveTraceObserverDeps) {}

  async handle(event: AgentEvent): Promise<void> {
    const descriptor = toStepDescriptor(event)
    if (!descriptor) return

    const stepId = `step_${ulid()}`
    const sealed = await sealMessage({
      key: this.deps.replySsk,
      keyGeneration: this.deps.replyKeyGeneration,
      payload: descriptor.content,
      aad: buildMessageAad({ streamId: this.deps.streamId, messageId: stepId, senderId: this.deps.senderId }),
    })

    await this.deps.sendStep({
      stepId,
      stepType: descriptor.stepType,
      messageId: descriptor.messageId,
      ciphertext: bytesToBase64(sealed.ciphertext),
      envelope: sealed.envelope,
      durationMs: descriptor.durationMs,
    })
  }
}

interface StepDescriptor {
  stepType: EnclaveSealedStep["stepType"]
  /** The renderable step content — the same string a plaintext step persists in `content`. */
  content: string
  messageId?: string
  durationMs?: number
}

/** Map a runtime event to the sealed step it produces, or null for non-step events. */
function toStepDescriptor(event: AgentEvent): StepDescriptor | null {
  switch (event.type) {
    case "thinking":
      return { stepType: AgentStepTypes.THINKING, content: event.content, durationMs: event.durationMs }
    case "tool:complete":
      // The tool declares its own step type + rendered content (e.g. the search
      // query, the page title, the research brief). Seal that verbatim.
      return { stepType: event.trace.stepType, content: event.trace.content, durationMs: event.durationMs }
    case "tool:error":
      return { stepType: AgentStepTypes.TOOL_ERROR, content: event.error, durationMs: event.durationMs }
    case "message:sent":
      return { stepType: AgentStepTypes.MESSAGE_SENT, content: event.content, messageId: event.messageId }
    default:
      return null
  }
}
