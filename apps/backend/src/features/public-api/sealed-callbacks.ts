import type { Pool } from "pg"
import type { Server } from "socket.io"
import { HttpError } from "@threa/backend-common"
import type { AgentStepType } from "@threa/types"
import { withTransaction } from "../../db"
import {
  AgentSessionRepository,
  assertReplyKeyGeneration,
  assertSessionRunning,
  verifyCallbackToken,
  type AgentSession,
  type AgentSessionStep,
} from "../agents"
import { StreamRepository, type Stream } from "../streams"
import { BotRepository, type Bot } from "./bot-repository"
import { serializeTraceStep } from "./trace-steps"

/**
 * The resolved identity of one sealed bot-session callback: the running
 * session, its stream, and the bot the API key belongs to, all cross-checked.
 */
export interface SealedCallbackContext {
  session: AgentSession
  stream: Stream
  bot: Bot
  callbackToken: string
}

/**
 * Resolve and authorize a sealed bot session callback — the transport-neutral
 * core shared by the sealed HTTP handlers (`/sealed-steps`, `/sealed-steps/started`,
 * `/sealed-complete`, `/sealed-messages`) and the `bot:invocation:sealed-steps`
 * WS frame. Bot invocations reuse the invocation id as the agent session id, so
 * `invocationId` is the session id. The neutral callback token (model A — the
 * claim token, delivered only inside the winning sealed claim) is the binding;
 * the workspace + persona checks are defense-in-depth isolation (INV-8) on top
 * of it. Mirrors the enclave's `assertRunning`/`assertCallbackBound` + stream
 * resolution.
 */
export async function authorizeSealedCallback(
  pool: Pool,
  params: { workspaceId: string; botId: string; invocationId: string; callbackToken: string | undefined }
): Promise<SealedCallbackContext> {
  const session = await AgentSessionRepository.findById(pool, params.invocationId)
  assertSessionRunning(session)
  verifyCallbackToken(session, params.callbackToken)
  const stream = await StreamRepository.findById(pool, session.streamId)
  if (!stream || stream.workspaceId !== params.workspaceId) {
    throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })
  }
  const bot = await BotRepository.findById(pool, params.workspaceId, params.botId)
  if (!bot || bot.archivedAt) throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
  if (session.personaId !== bot.id) {
    throw new HttpError("Session does not belong to this bot", { status: 403, code: "FORBIDDEN" })
  }
  return { session, stream, bot, callbackToken: params.callbackToken! }
}

/**
 * Drive the inline stream-view indicator at a sealed step boundary — the same
 * `agent_session:progress` payload the plaintext sink emits, step type only
 * (never sealed content). Emitted at step start (and on the finalize fallback
 * when the start was dropped) so "<bot> is …" tracks the live step.
 */
export function emitBotSealedProgress(
  io: Server,
  ctx: Pick<SealedCallbackContext, "stream" | "session" | "bot">,
  step: AgentSessionStep
): void {
  io.to(`ws:${ctx.stream.workspaceId}:stream:${ctx.session.streamId}`).emit("agent_session:progress", {
    workspaceId: ctx.stream.workspaceId,
    streamId: ctx.session.streamId,
    sessionId: ctx.session.id,
    triggerMessageId: ctx.session.triggerMessageId,
    personaName: ctx.bot.name,
    stepCount: step.stepNumber,
    messageCount: 0,
    currentStepType: step.stepType,
  })
}

/** One sealed step to finalize (the `/sealed-steps` wire shape, transport-neutral). */
export interface SealedStepFinalizeFrame {
  stepId: string
  stepType: AgentStepType
  messageId?: string
  ciphertext: string
  envelope: { v: number; keyGeneration: number; iv: string; aad: string }
  durationMs?: number
}

/**
 * Finalize one sealed trace step in place when it completes — set the sealed
 * content + completed_at on the row opened at sealed `/steps/started`, keeping
 * its original started_at so the duration is real. The content is ciphertext
 * only; the owner's browser decrypts it (INV-E7). If the start write was
 * dropped, fall back to a race-safe completed insert so the trace still lands.
 * Shared verbatim by the HTTP `/sealed-steps` handler and the WS frame — the
 * external sibling of the enclave's `/steps`.
 */
export async function finalizeSealedStep(
  deps: { pool: Pool; io: Server },
  ctx: SealedCallbackContext,
  frame: SealedStepFinalizeFrame
): Promise<AgentSessionStep> {
  const { pool, io } = deps
  const { session } = ctx
  assertReplyKeyGeneration(session, frame.envelope)

  const completedAt = new Date()
  // Scope the finalize to this session: frame.stepId is caller-supplied, so an
  // unscoped update would let a bot overwrite another session's step row.
  let persisted = await AgentSessionRepository.updateStep(pool, frame.stepId, {
    sessionId: session.id,
    contentCiphertext: frame.ciphertext,
    contentEnvelope: frame.envelope,
    messageId: frame.messageId,
    completedAt,
  })

  // Fallback: the start write never landed (dropped/raced), so there's no row
  // to finalize. Insert a completed row + advance current_step_type (INV-6,
  // INV-20) so the trace and inline indicator still reflect this step.
  if (!persisted) {
    const startedAt = new Date(completedAt.getTime() - (frame.durationMs ?? 0))
    persisted = await withTransaction(pool, async (tx) => {
      const created = await AgentSessionRepository.appendStep(tx, {
        id: frame.stepId,
        sessionId: session.id,
        stepType: frame.stepType,
        messageId: frame.messageId,
        contentCiphertext: frame.ciphertext,
        contentEnvelope: frame.envelope,
        startedAt,
        completedAt,
      })
      await AgentSessionRepository.updateCurrentStepType(tx, session.id, frame.stepType)
      return created
    })
    emitBotSealedProgress(io, ctx, persisted)
  }

  io.to(`ws:${ctx.stream.workspaceId}:agent_session:${session.id}`).emit("agent_session:step:completed", {
    sessionId: session.id,
    step: serializeTraceStep(persisted),
  })

  return persisted
}
