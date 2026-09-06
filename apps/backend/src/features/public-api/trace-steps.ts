import { randomUUID } from "crypto"
import type { Pool, PoolClient } from "pg"
import type { Server } from "socket.io"
import { AgentStepTypes, type AgentStepType, type AuthorType } from "@threahq/types"
import {
  TraceProjector,
  type AgentEvent,
  type TraceStepFinalize,
  type TraceStepRecord,
  type TraceStepSink,
  type TraceSubstepEntry,
} from "@threahq/agent-runtime"
import { withTransaction, type Querier } from "../../db"
import { stepId as generateStepId } from "../../lib/id"
import { AgentSessionRepository, type AgentSessionStep, type ParentActivityTarget } from "../agents"

/**
 * Serialize a trace step for `agent_session:step:completed` socket emission.
 *
 * Shared by every runtime that streams steps back to the session room — in-flight
 * Pi bot invocations and the E2E enclave — so the frontend handler stays
 * source-agnostic. E2E steps carry sealed `contentCiphertext` + `contentEnvelope`
 * in place of plaintext `content`; the server only relays the ciphertext and the
 * browser decrypts (INV-E7).
 */
export function serializeTraceStep(step: AgentSessionStep) {
  return {
    id: step.id,
    sessionId: step.sessionId,
    stepNumber: step.stepNumber,
    stepType: step.stepType,
    content: (step.content ?? undefined) as string | undefined,
    sources: step.sources ?? undefined,
    messageId: step.messageId ?? undefined,
    tokensUsed: step.tokensUsed ?? undefined,
    // Carried for the same reason session-handlers.ts carries it: a
    // field-by-field serializer silently drops a new step field, and the
    // symptom is a badge that renders live and vanishes on reload. Bot/enclave
    // sessions have no guarded tools today, so this is always absent — which is
    // exactly why it would go unnoticed if the next surface does grow one.
    verification: step.verification,
    effects: step.effects,
    duration: step.completedAt && step.startedAt ? step.completedAt.getTime() - step.startedAt.getTime() : undefined,
    startedAt: step.startedAt.toISOString(),
    completedAt: step.completedAt?.toISOString(),
    contentCiphertext: step.contentCiphertext ?? undefined,
    contentEnvelope: step.contentEnvelope ?? undefined,
  }
}

/**
 * Normalize one bot `/steps` wire frame into the `AgentEvent` vocabulary the
 * shared `TraceProjector` consumes — the external runtime's stand-in for the
 * events an in-process `AgentRuntime` emits itself.
 *
 * Today's wire delivers each step post-hoc as a single completed frame, so:
 * - a `thinking` frame is the runtime's `thinking` event (duration unknown);
 * - every other frame becomes a back-to-back `tool:start` + `tool:complete`
 *   pair carrying the frame's stepType and pre-rendered content verbatim.
 *   That includes `tool_error` frames: the bot already formatted the error
 *   into the content, so mapping them to a `tool:error` event would have the
 *   projector re-wrap it ("<tool> failed: …") and mangle the Pi trace JSON.
 *
 * Richer in-flight frames (real start/progress/complete) arrive with the
 * Phase 2 contract and map onto the same vocabulary.
 */
export function botInvocationStepEvents(frame: { stepType: AgentStepType; content: string }): AgentEvent[] {
  if (frame.stepType === AgentStepTypes.THINKING) {
    return [{ type: "thinking", content: frame.content, durationMs: 0 }]
  }
  // Correlates the synthesized start/complete pair; never persisted.
  const toolCallId = randomUUID()
  return [
    {
      type: "tool:start",
      toolCallId,
      toolName: frame.stepType,
      stepType: frame.stepType,
      input: {},
    },
    {
      type: "tool:complete",
      toolCallId,
      toolName: frame.stepType,
      input: {},
      output: frame.content,
      durationMs: 0,
      trace: { stepType: frame.stepType, content: frame.content },
    },
  ]
}

/** The sink's handle for a projector-opened tool step — see `open` below. */
interface BotOpenStep {
  stepType: AgentStepType
}

interface BotInvocationTraceSinkDeps {
  pool: Pool | PoolClient
  io: Server
  workspaceId: string
  /** The invocation id — bot invocations reuse it as the agent session id. */
  sessionId: string
  streamId: string
  triggerMessageId: string
  personaName: string
  /**
   * Set when the session runs in a thread: the inline indicator events also go
   * to the parent timeline's room, keyed on the thread's anchor — the same
   * fan-out `SessionTrace` gives an in-process session (see `parentActivityTarget`).
   */
  parent?: ParentActivityTarget | null
}

/**
 * The external-bot sink for the shared `TraceProjector`: normalized invocation
 * frames land as completed `agent_session_steps` rows plus the same
 * `agent_session:step:completed` / `agent_session:progress` emits the other
 * runtimes drive. Today's wire delivers steps post-hoc (already completed), so
 * `open` is deferred — the row is written once, at `complete` — and no
 * `step:started` frame is emitted, exactly as before normalization.
 */
export class BotInvocationTraceSink implements TraceStepSink<BotOpenStep> {
  /** The last persisted step row — the `/steps` handler's response body needs its id. */
  lastStep: AgentSessionStep | null = null
  /**
   * Idempotency key for the NEXT step this sink records. The frames in a batch
   * share one projector + sink, so the caller sets this before driving each
   * frame's events through the projector; `record` consumes it one-shot (reads
   * then clears) so a re-sent step dedups to the existing row and the key can
   * never leak into a following step.
   */
  pendingClientStepId: string | undefined = undefined

  constructor(private readonly deps: BotInvocationTraceSinkDeps) {}

  async record(step: TraceStepRecord): Promise<void> {
    const { pool, io, workspaceId, sessionId, streamId, triggerMessageId, personaName, parent } = this.deps
    const completedAt = new Date()
    const startedAt = new Date(completedAt.getTime() - (step.durationMs ?? 0))
    // Consume the idempotency key as a one-shot: clear it before the insert so a
    // frame that ever produces two `record()` calls can't carry the first call's
    // key into the second (which would dedup to the first row and silently drop
    // the second step). Today's wire is one step per frame, but this keeps the
    // invariant from depending on that.
    const clientStepId = this.pendingClientStepId
    this.pendingClientStepId = undefined
    const stepId = generateStepId()
    // Append + currentStepType must run in one transaction. appendStep is
    // race-safe for concurrent step POSTs (INV-20), so simultaneous Pi events
    // append distinct rows instead of clobbering each other.
    const persisted = await withTransaction(pool, async (client) => {
      const inserted = await AgentSessionRepository.appendStep(client, {
        id: stepId,
        sessionId,
        stepType: step.stepType,
        content: step.content,
        sources: step.sources,
        messageId: step.messageId,
        startedAt,
        completedAt,
        clientStepId,
      })
      // Only advance current_step_type on a real insert. On an idempotent dedup
      // appendStep returns the pre-existing row (a different id than the one we
      // generated); its type was set when it first landed, and re-setting it from
      // this replay would write the replay's type and regress to an older step.
      if (inserted.id === stepId) {
        await AgentSessionRepository.updateCurrentStepType(client, sessionId, inserted.stepType)
      }
      return inserted
    })
    this.lastStep = persisted
    // A deduped replay was already broadcast when it first landed — re-emitting it
    // (with its older stepNumber/type) would flicker the live indicators backward,
    // so the broadcast is gated on the row being freshly inserted by this call.
    if (persisted.id === stepId) {
      io.to(`ws:${workspaceId}:agent_session:${sessionId}`).emit("agent_session:step:completed", {
        sessionId,
        step: serializeTraceStep(persisted),
      })
      let progress = io.to(`ws:${workspaceId}:stream:${streamId}`)
      if (parent) progress = progress.to(`ws:${workspaceId}:stream:${parent.parentStreamId}`)
      progress.emit("agent_session:progress", {
        workspaceId,
        streamId,
        sessionId,
        triggerMessageId,
        personaName,
        stepCount: persisted.stepNumber,
        messageCount: 0,
        currentStepType: persisted.stepType,
        threadStreamId: parent ? streamId : undefined,
        parentMessageId: parent?.parentMessageId,
      })
    }
  }

  async open(params: { stepType: AgentStepType }): Promise<BotOpenStep> {
    // Deferred: today's frames arrive already completed (the normalizer emits
    // start + complete back-to-back), so in-flight visibility never existed on
    // this wire and the row is written once, at complete.
    return { stepType: params.stepType }
  }

  async complete(_step: BotOpenStep, final: TraceStepFinalize): Promise<void> {
    await this.record({
      stepType: final.stepType,
      content: final.content,
      sources: final.sources,
      messageId: final.messageId,
      durationMs: final.durationMs,
    })
  }

  /**
   * Guarded (tier 2+) tools are never offered on this surface — bot invocation
   * frames are normalized from an external bot's own reported steps, not
   * executed here — so a verdict cannot arrive. Required by `TraceStepSink` all
   * the same: the interface makes every surface decide what it does with one,
   * which is the only guard available (a runtime throw is swallowed by
   * `AgentRuntime.emit`).
   */
  async verify(): Promise<void> {
    throw new Error(
      "BotInvocationTraceSink cannot record a guardian verdict; guarded tools must not run on this surface"
    )
  }

  /**
   * Same reasoning as `verify`: our mutating tools are built only in the
   * companion's tool set, never on this surface, so an effect cannot arrive.
   * Required all the same — the compiler is the only guard.
   */
  async effects(): Promise<void> {
    throw new Error("BotInvocationTraceSink cannot record tool effects; mutating tools must not run on this surface")
  }
  async substep(params: { stepType: AgentStepType; text: string; snapshot: TraceSubstepEntry[] }): Promise<void> {
    // Mirrors SessionTrace.emitSubstep's fan-out: ephemeral phase text to the
    // stream room (inline indicator) and the session room (trace dialog).
    // Unreachable from today's wire (the normalizer emits no tool:progress);
    // here so richer Phase 2 frames land on a complete sink.
    const { io, workspaceId, sessionId, streamId, triggerMessageId, parent } = this.deps
    const payload = {
      workspaceId,
      streamId,
      sessionId,
      triggerMessageId,
      stepType: params.stepType,
      substep: params.text,
      updatedAt: new Date().toISOString(),
    }
    let stream = io.to(`ws:${workspaceId}:stream:${streamId}`)
    if (parent) stream = stream.to(`ws:${workspaceId}:stream:${parent.parentStreamId}`)
    stream.emit("agent_session:substep", payload)
    io.to(`ws:${workspaceId}:agent_session:${sessionId}`).emit("agent_session:substep", payload)
  }
}

/** The external-bot trace projector: the shared state machine over the invocation sink. */
export function createBotInvocationTraceProjector(deps: BotInvocationTraceSinkDeps): {
  projector: TraceProjector<BotOpenStep>
  sink: BotInvocationTraceSink
} {
  const sink = new BotInvocationTraceSink(deps)
  return { projector: new TraceProjector(sink), sink }
}

/**
 * Persist-only sink for reconstructing a trace after the fact: rows land on the
 * caller's querier (the completion handler owns the transaction, INV-6) and
 * nothing is emitted — there is no in-flight run to deliver to. The handler
 * emits `step:completed` frames for the collected rows once they're durable.
 */
class SynthesizedTraceSink implements TraceStepSink<BotOpenStep> {
  readonly steps: AgentSessionStep[] = []

  /**
   * Guarded (tier 2+) tools are never offered on this surface — these steps are
   * reconstructed from a bot's own reported frames, not executed here — so a
   * verdict cannot arrive. Required by `TraceStepSink` all the same: the
   * interface makes every surface decide what it does with one, which is the
   * only guard available (a runtime throw is swallowed by `AgentRuntime.emit`).
   */
  async verify(): Promise<void> {
    throw new Error("SynthesizedTraceSink cannot record a guardian verdict; guarded tools must not run on this surface")
  }

  /**
   * Same reasoning as `verify`: these steps are reconstructed from a bot's own
   * reported frames, not executed here, so an effect cannot arrive. Required
   * all the same — the compiler is the only guard.
   */
  async effects(): Promise<void> {
    throw new Error("SynthesizedTraceSink cannot record tool effects; mutating tools must not run on this surface")
  }

  constructor(
    private readonly db: Querier,
    private readonly sessionId: string
  ) {}

  async record(step: TraceStepRecord): Promise<void> {
    const completedAt = new Date()
    this.steps.push(
      await AgentSessionRepository.appendStep(this.db, {
        id: generateStepId(),
        sessionId: this.sessionId,
        stepType: step.stepType,
        content: step.content,
        sources: step.sources,
        messageId: step.messageId,
        startedAt: new Date(completedAt.getTime() - (step.durationMs ?? 0)),
        completedAt,
      })
    )
  }

  async open(params: { stepType: AgentStepType }): Promise<BotOpenStep> {
    // Reconstruction is post-hoc: like the invocation sink, the row is written
    // once, at complete.
    return { stepType: params.stepType }
  }

  async complete(_step: BotOpenStep, final: TraceStepFinalize): Promise<void> {
    await this.record({
      stepType: final.stepType,
      content: final.content,
      sources: final.sources,
      messageId: final.messageId,
      durationMs: final.durationMs,
    })
  }

  async substep(): Promise<void> {
    // No live run to deliver phase text to.
  }
}

/**
 * The synthesized-trace floor for reply-only harnesses (N-6): a bot that never
 * POSTs `/steps` would otherwise complete with an empty activity card, so the
 * completion handler reconstructs the minimal `context_received` →
 * `message_sent` trace from what it knows — the invocation's prompt and the
 * reply it just created. The events ride the shared `TraceProjector`, so the
 * persisted shapes are exactly what every other surface writes; the context
 * step carries `synthesized: true` so the frontend can label the trace as
 * reconstructed rather than reported.
 */
export async function synthesizeReplyOnlyBotTrace(
  db: Querier,
  params: {
    sessionId: string
    trigger: { messageId: string; authorName: string; authorType: AuthorType; createdAt: string; content: string }
    reply: { messageId: string; content: string }
  }
): Promise<AgentSessionStep[]> {
  const sink = new SynthesizedTraceSink(db, params.sessionId)
  const projector = new TraceProjector(sink)
  await projector.handle({
    type: "context:received",
    messages: [{ ...params.trigger, isTrigger: true }],
    extras: { synthesized: true },
  })
  await projector.handle({ type: "message:sent", messageId: params.reply.messageId, content: params.reply.content })
  return sink.steps
}
