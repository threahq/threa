import type { Pool, PoolClient } from "pg"
import type { Server } from "socket.io"
import type { AgentStepType, AgentToolEffect, ToolVerificationStatus, TraceSource } from "@threahq/types"
import { withTransaction } from "../../db"
import { AgentSessionRepository, CompanionExecutionLostError, type CompanionExecutionRef } from "./session-repository"
import { emitAgentActivityEnded, emitAgentActivityStarted } from "./activity-indicator"
import { stepId as generateStepId } from "../../lib/id"

interface TraceEmitterDeps {
  io: Server
  pool: Pool
}

/**
 * Injectable service for emitting agent trace events.
 * Handles step lifecycle (start → progress → complete) with:
 * - DB persistence for start and complete (crash-resilient)
 * - Socket emission for real-time UI updates
 * - No held connections (each DB write is one short transaction)
 * - Durable writes commit only while the claimed execution still holds the session
 */
export class TraceEmitter {
  constructor(private readonly deps: TraceEmitterDeps) {}

  forSession(params: {
    sessionId: string
    workspaceId: string
    streamId: string
    triggerMessageId: string
    personaName: string
    /**
     * The generation this execution claimed; every socket frame carries it so
     * clients can drop a replaced generation's late frames. Null only for a
     * terminal row no generation can reclaim: its frames apply unconditionally
     * and it never persists a step.
     */
    executionGeneration: number | null
    /**
     * When the session runs in a thread: the parent stream's id, so inline
     * indicator events (activity/progress/substeps) also reach viewers of the
     * parent timeline — the channel for channel mentions, the enclosing
     * stream for mentions inside an existing thread.
     */
    parentStreamId?: string
    /**
     * The thread's parent message id. Parent-timeline viewers can't see the
     * trigger message (it's inside the thread), so the frontend keys the
     * indicator off this message instead.
     */
    parentMessageId?: string
  }): SessionTrace {
    return new SessionTrace(this.deps, params)
  }
}

/**
 * Trace handle for a single agent session.
 * Owns step numbering and session-scoped socket rooms.
 */
export class SessionTrace {
  private stepNumber = 0
  private messageCount = 0
  private readonly sessionRoom: string
  private readonly streamRoom: string
  private readonly parentRoom: string | null

  constructor(
    private readonly deps: TraceEmitterDeps,
    private readonly params: {
      sessionId: string
      workspaceId: string
      streamId: string
      triggerMessageId: string
      personaName: string
      executionGeneration: number | null
      parentStreamId?: string
      parentMessageId?: string
    }
  ) {
    this.sessionRoom = `ws:${params.workspaceId}:agent_session:${params.sessionId}`
    this.streamRoom = `ws:${params.workspaceId}:stream:${params.streamId}`
    this.parentRoom = params.parentStreamId ? `ws:${params.workspaceId}:stream:${params.parentStreamId}` : null
  }

  /**
   * Start a step. Persists to DB + emits to socket.
   * Returns an ActiveStep handle for progress/complete.
   */
  async startStep(params: { stepType: AgentStepType; content?: string }): Promise<ActiveStep> {
    this.stepNumber++
    if (params.stepType === "message_sent" || params.stepType === "message_edited") this.messageCount++
    const now = new Date()
    if (this.params.executionGeneration === null) {
      throw new Error(`Trace handle for session ${this.params.sessionId} has no execution to persist steps for`)
    }
    const execution = { sessionId: this.params.sessionId, generation: this.params.executionGeneration }

    const step = await writeForExecution(this.deps.pool, execution, this.params.workspaceId, async (tx) => {
      const upserted = await AgentSessionRepository.upsertStep(tx, {
        id: generateStepId(),
        sessionId: this.params.sessionId,
        stepNumber: this.stepNumber,
        stepType: params.stepType,
        content: params.content,
        startedAt: now,
      })
      // Current step type for cross-stream display, from the persisted row.
      await AgentSessionRepository.updateCurrentStepType(tx, this.params.sessionId, upserted.stepType)
      return upserted
    })
    const stepId = step.id
    const startedAt = step.startedAt ?? now
    const stepNumber = step.stepNumber
    const stepType = step.stepType
    const stepContent = step.content ?? params.content

    // Emit to session room (detailed, for trace dialog)
    this.deps.io.to(this.sessionRoom).emit("agent_session:step:started", {
      sessionId: this.params.sessionId,
      step: {
        id: stepId,
        sessionId: this.params.sessionId,
        stepNumber,
        stepType,
        content: stepContent,
        startedAt: startedAt.toISOString(),
      },
    })

    // Emit to stream room (lightweight, for timeline card + trigger message indicator)
    // When parentRoom is set, also emit to the parent stream for the inline indicator
    // Include threadStreamId so frontend can link directly to thread before stream:created arrives
    const progressPayload = {
      workspaceId: this.params.workspaceId,
      streamId: this.params.streamId,
      sessionId: this.params.sessionId,
      triggerMessageId: this.params.triggerMessageId,
      personaName: this.params.personaName,
      stepCount: stepNumber,
      messageCount: this.messageCount,
      currentStepType: stepType,
      threadStreamId: this.params.parentStreamId ? this.params.streamId : undefined,
      parentMessageId: this.params.parentMessageId,
      executionGeneration: this.generationOnWire(),
    }
    let target = this.deps.io.to(this.streamRoom)
    if (this.parentRoom) {
      target = target.to(this.parentRoom)
    }
    target.emit("agent_session:progress", progressPayload)

    return new ActiveStep(this.deps, {
      stepId,
      execution,
      workspaceId: this.params.workspaceId,
      sessionRoom: this.sessionRoom,
      startedAt,
    })
  }

  /**
   * Emit an ephemeral substep update for a running step.
   *
   * Used by long-running tools (e.g. workspace_research) to stream phase text to
   * the UI without creating a new persisted step row. The persisted step's `content`
   * (baked in by the tool's `trace.formatContent`) retains the full substep history
   * on completion — see `WorkspaceAgentResult.substeps` and
   * `workspace-research-tool.ts trace.formatContent`.
   *
   * Emits to BOTH the stream room (timeline inline card) and the session room
   * (trace dialog). No DB write, no step number increment.
   */
  emitSubstep(params: { stepType: AgentStepType; substep: string }): void {
    const payload = {
      workspaceId: this.params.workspaceId,
      streamId: this.params.streamId,
      sessionId: this.params.sessionId,
      triggerMessageId: this.params.triggerMessageId,
      stepType: params.stepType,
      substep: params.substep,
      updatedAt: new Date().toISOString(),
    }
    // Stream room (timeline inline) — include the parent stream's room for thread sessions
    let target = this.deps.io.to(this.streamRoom)
    if (this.parentRoom) {
      target = target.to(this.parentRoom)
    }
    target.emit("agent_session:substep", payload)
    // Session room (trace dialog live streaming)
    this.deps.io.to(this.sessionRoom).emit("agent_session:substep", payload)
  }

  private generationOnWire(): number | undefined {
    return this.params.executionGeneration ?? undefined
  }

  /** Notify session room that session completed. Socket only. */
  notifyCompleted(): void {
    this.deps.io.to(this.sessionRoom).emit("agent_session:completed", {
      sessionId: this.params.sessionId,
      executionGeneration: this.generationOnWire(),
    })
  }

  /** Notify session room that session failed. Socket only. */
  notifyFailed(): void {
    this.deps.io.to(this.sessionRoom).emit("agent_session:failed", {
      sessionId: this.params.sessionId,
      executionGeneration: this.generationOnWire(),
    })
  }

  /** Notify the parent stream's room that agent activity started. For immediate inline indicator. */
  notifyActivityStarted(): void {
    if (!this.params.parentStreamId || !this.params.parentMessageId) return
    emitAgentActivityStarted(this.deps.io, {
      workspaceId: this.params.workspaceId,
      sessionId: this.params.sessionId,
      triggerMessageId: this.params.triggerMessageId,
      personaName: this.params.personaName,
      threadStreamId: this.params.streamId,
      target: { parentStreamId: this.params.parentStreamId, parentMessageId: this.params.parentMessageId },
      executionGeneration: this.generationOnWire(),
    })
  }

  /** Notify the parent stream's room that agent activity ended. For inline indicator cleanup. */
  notifyActivityEnded(): void {
    emitAgentActivityEnded(this.deps.io, {
      workspaceId: this.params.workspaceId,
      streamId: this.params.streamId,
      parentStreamId: this.params.parentStreamId,
      sessionId: this.params.sessionId,
      triggerMessageId: this.params.triggerMessageId,
      executionGeneration: this.generationOnWire(),
    })
  }
}

/** One short transaction that commits `write` only while `execution` holds the session. */
function writeForExecution<T>(
  pool: Pool,
  execution: CompanionExecutionRef,
  workspaceId: string,
  write: (tx: PoolClient) => Promise<T>
): Promise<T> {
  return withTransaction(pool, async (tx) => {
    await AgentSessionRepository.lockHeldExecution(tx, execution, { workspaceId })
    return write(tx)
  })
}

/**
 * Handle for an in-progress step.
 * Supports ephemeral progress updates and final completion.
 */
export class ActiveStep {
  constructor(
    private readonly deps: TraceEmitterDeps,
    private readonly params: {
      stepId: string
      execution: CompanionExecutionRef
      workspaceId: string
      sessionRoom: string
      startedAt: Date
    }
  ) {}

  private write<T>(update: (tx: PoolClient) => Promise<T>): Promise<T> {
    return writeForExecution(this.deps.pool, this.params.execution, this.params.workspaceId, update)
  }

  /** Ephemeral progress update. Socket only, not persisted. */
  progress(data: { content?: string }): void {
    this.deps.io.to(this.params.sessionRoom).emit("agent_session:step:progress", {
      sessionId: this.params.execution.sessionId,
      stepId: this.params.stepId,
      content: data.content,
    })
  }

  /**
   * Persist a running substep log to the step's content field.
   *
   * Called by `SessionTraceStepSink` on every `tool:progress` event so that a
   * browser refresh mid-execution sees the phases collected so far rather than
   * a gap. Writes a minimal `{ substeps: [...] }` JSON; `complete()` later
   * overwrites with the tool's full content (which includes the same substeps
   * plus counts, partial flag, etc.).
   *
   * IMPORTANT: the content is pre-stringified before being passed to
   * `updateStep`. This matches the convention used by every other observer
   * site (e.g. `context_received`, `reconsidering` both call `JSON.stringify`
   * explicitly). `updateStep` applies a second `JSON.stringify` on top, which
   * makes the column round-trip as a JS string (JSONB string type) rather
   * than an auto-parsed object — the frontend's wire type expects
   * `content?: string`, not an object, and will crash trying to render a raw
   * object as a JSX child.
   *
   * Not emitted to the socket — the live substep stream is already handled by
   * `SessionTrace.emitSubstep`.
   */
  async updateSubsteps(substeps: Array<{ text: string; at: string }>): Promise<void> {
    // requireRunning guards the finalize race: the sink fires these writes
    // without awaiting, so a delayed snapshot can reach the DB after
    // `complete()` finalized the row — it must not overwrite the final
    // content with a mid-run partial. Once finalized this no-ops, the same
    // guard the enclave's substep-snapshot path uses.
    // A snapshot from an execution that lost the session is dropped, never written over the replacement's step.
    try {
      await this.write((tx) =>
        AgentSessionRepository.updateStep(tx, this.params.stepId, {
          content: JSON.stringify({ substeps }),
          requireRunning: true,
        })
      )
    } catch (err) {
      if (err instanceof CompanionExecutionLostError) return
      throw err
    }
  }

  /**
   * Record the guardian's state for a guarded tool call on this step.
   *
   * Awaited, unlike `updateSubsteps`: the verdict decides whether the action
   * happens, so it must be durable before the runtime acts on it. Written as a
   * patch, so a `pending` write followed by the verdict leaves one row that
   * moves through both states rather than two rows.
   */
  async verify(params: { status: ToolVerificationStatus; reason?: string }): Promise<void> {
    await this.write((tx) =>
      AgentSessionRepository.updateStep(tx, this.params.stepId, {
        verification: { status: params.status, ...(params.reason ? { reason: params.reason } : {}) },
      })
    )

    this.deps.io.to(this.params.sessionRoom).emit("agent_session:step:verification", {
      sessionId: this.params.execution.sessionId,
      stepId: this.params.stepId,
      verification: { status: params.status, reason: params.reason },
    })
  }

  /**
   * Record what this tool call wrote.
   *
   * Awaited, and with no socket emit of its own: the projector calls this
   * before the finalize, so `complete`'s RETURNING row carries the effects into
   * the `agent_session:step:completed` frame the live trace already consumes.
   */
  async effects(effects: AgentToolEffect[]): Promise<void> {
    await this.write((tx) => AgentSessionRepository.updateStep(tx, this.params.stepId, { effects }))
  }

  /** Complete the step. Persists to DB + emits to socket. */
  async complete(params?: {
    content?: string
    sources?: TraceSource[]
    messageId?: string
    /** If provided, completedAt is computed as startedAt + durationMs */
    durationMs?: number
  }): Promise<void> {
    // Compute completedAt as startedAt + durationMs to record accurate
    // durations when a step is logged after the operation already completed.
    const completedAt =
      params?.durationMs !== undefined ? new Date(this.params.startedAt.getTime() + params.durationMs) : new Date()

    const updated = await this.write((tx) =>
      AgentSessionRepository.updateStep(tx, this.params.stepId, {
        content: params?.content,
        sources: params?.sources,
        messageId: params?.messageId,
        completedAt,
      })
    )

    this.deps.io.to(this.params.sessionRoom).emit("agent_session:step:completed", {
      sessionId: this.params.execution.sessionId,
      step: updated
        ? {
            id: updated.id,
            sessionId: updated.sessionId,
            stepNumber: updated.stepNumber,
            stepType: updated.stepType,
            content: updated.content,
            sources: updated.sources,
            messageId: updated.messageId,
            verification: updated.verification,
            effects: updated.effects,
            startedAt: updated.startedAt.toISOString(),
            completedAt: updated.completedAt?.toISOString(),
          }
        : { id: this.params.stepId, completedAt: completedAt.toISOString() },
    })
  }
}
