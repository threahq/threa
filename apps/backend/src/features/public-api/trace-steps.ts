import { randomUUID } from "crypto"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import { AgentStepTypes, type AgentStepType } from "@threa/types"
import {
  TraceProjector,
  type AgentEvent,
  type TraceStepFinalize,
  type TraceStepRecord,
  type TraceStepSink,
  type TraceSubstepEntry,
} from "@threa/agent-runtime"
import { withTransaction } from "../../db"
import { stepId as generateStepId } from "../../lib/id"
import { AgentSessionRepository, type AgentSessionStep } from "../agents"

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
  // Correlation id pairing the synthesized start/complete; never persisted.
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
  pool: Pool
  io: Server
  workspaceId: string
  /** The invocation id — bot invocations reuse it as the agent session id. */
  sessionId: string
  streamId: string
  triggerMessageId: string
  personaName: string
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

  constructor(private readonly deps: BotInvocationTraceSinkDeps) {}

  async record(step: TraceStepRecord): Promise<void> {
    const { pool, io, workspaceId, sessionId, streamId, triggerMessageId, personaName } = this.deps
    const completedAt = new Date()
    const startedAt = new Date(completedAt.getTime() - (step.durationMs ?? 0))
    // Append + currentStepType must run in one transaction. appendStep is
    // race-safe for concurrent step POSTs (INV-20), so simultaneous Pi events
    // append distinct rows instead of clobbering each other.
    const persisted = await withTransaction(pool, async (client) => {
      const inserted = await AgentSessionRepository.appendStep(client, {
        id: generateStepId(),
        sessionId,
        stepType: step.stepType,
        content: step.content,
        sources: step.sources,
        messageId: step.messageId,
        startedAt,
        completedAt,
      })
      await AgentSessionRepository.updateCurrentStepType(client, sessionId, step.stepType)
      return inserted
    })
    this.lastStep = persisted
    io.to(`ws:${workspaceId}:agent_session:${sessionId}`).emit("agent_session:step:completed", {
      sessionId,
      step: serializeTraceStep(persisted),
    })
    io.to(`ws:${workspaceId}:stream:${streamId}`).emit("agent_session:progress", {
      workspaceId,
      streamId,
      sessionId,
      triggerMessageId,
      personaName,
      stepCount: persisted.stepNumber,
      messageCount: 0,
      currentStepType: persisted.stepType,
    })
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

  async substep(params: { stepType: AgentStepType; text: string; snapshot: TraceSubstepEntry[] }): Promise<void> {
    // Mirrors SessionTrace.emitSubstep's fan-out: ephemeral phase text to the
    // stream room (inline indicator) and the session room (trace dialog).
    // Unreachable from today's wire (the normalizer emits no tool:progress);
    // here so richer Phase 2 frames land on a complete sink.
    const { io, workspaceId, sessionId, streamId, triggerMessageId } = this.deps
    const payload = {
      workspaceId,
      streamId,
      sessionId,
      triggerMessageId,
      stepType: params.stepType,
      substep: params.text,
      updatedAt: new Date().toISOString(),
    }
    io.to(`ws:${workspaceId}:stream:${streamId}`).emit("agent_session:substep", payload)
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
