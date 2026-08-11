import type { Pool } from "pg"
import type { Server } from "socket.io"
import { withTransaction } from "../../db"
import { HttpError } from "@threa/backend-common"
import { invocationClaimNotFound } from "./errors"
import { BotInvocationTriggers, BotRuntimeKinds } from "@threa/types"
import {
  assertManifestAllows,
  type BotRuntimeInstance,
  type BotRuntimeService,
  type BotRuntimeWriteOps,
  type ApplyPresenceParams,
  type TouchPresenceParams,
  type RenewClaimParams,
  type RenewClaimResult,
  type RecordStepsParams,
  type RecordStepsResult,
  type RecordStepResult,
  type RecordSealedStepsParams,
  type RecordSealedStepsResult,
} from "../bot-runtimes"
import { authorizeSealedCallback, finalizeSealedStep } from "./sealed-callbacks"
import { E2eStreamsRepository } from "../e2e-streams"
import { BotChannelAccessRepository, type BotChannelService } from "../api-keys"
import { AgentSessionRepository, failSessionWithLifecycleInTransaction, SessionStatuses } from "../agents"
import { assertStreamWritable, StreamRepository } from "../streams"
import { BotRepository } from "./bot-repository"
import { botInvocationStepEvents, createBotInvocationTraceProjector } from "./trace-steps"
import { sanitizeInvocationStepContent, sanitizeStatusText } from "./sanitize"
import { logger } from "../../lib/logger"

export interface BotRuntimeWriteOpsDeps {
  pool: Pool
  io: Server
  botRuntimeService: BotRuntimeService
  botChannelService: BotChannelService
}

/**
 * The shared persistence core for the bot-runtime background writes
 * (`presence` / `renew` / `steps`). Both the REST handlers and the `/bot`
 * WebSocket namespace call these so the two transports can never diverge — the
 * row writes, race-safety (INV-20), and `agent_session:*` / `bot_runtime:presence`
 * emits all live here once. See the `BotRuntimeWriteOps` contract in
 * `bot-runtimes/runtime-write-ops.ts` for the error/ack semantics.
 */
export function createBotRuntimeWriteOps(deps: BotRuntimeWriteOpsDeps): BotRuntimeWriteOps {
  const { pool, io, botRuntimeService, botChannelService } = deps

  /**
   * Fan a presence update out to every stream the bot is a member of. Frontend
   * subscribes via the stream room and patches its cached bootstrap. Keeps the
   * UI in sync without any client-side polling.
   */
  async function broadcastBotPresence(
    workspaceId: string,
    botId: string,
    presence: BotRuntimeInstance | null
  ): Promise<void> {
    const streamIds = await BotChannelAccessRepository.getGrantedStreamIds(pool, workspaceId, botId)
    if (streamIds.length === 0) return
    // Only pi-local runtimes create scratchpad session links; skip the lookup
    // when there's no presence or the runtime kind can't have linked sessions.
    const links =
      presence?.runtimeKind === BotRuntimeKinds.PI_LOCAL
        ? await botRuntimeService.findActivePiRemoteSessionsForStreams({ workspaceId, botId, streamIds })
        : new Map<string, { instanceId: string; runtimeSessionId: string }>()
    const payload = {
      workspaceId,
      botId,
      presence: presence
        ? {
            botId: presence.botId,
            runtimeKind: presence.runtimeKind,
            instanceId: presence.instanceId,
            displayName: presence.displayName,
            status: presence.status,
            acceptingInvocations: presence.acceptingInvocations,
            statusText: presence.statusText,
            lastSeenAt: presence.lastSeenAt.toISOString(),
          }
        : null,
    }
    const runtimeSessionId =
      typeof presence?.capabilities.runtimeSessionId === "string" ? presence.capabilities.runtimeSessionId : null
    for (const streamId of streamIds) {
      const link = links.get(streamId)
      const streamPresence =
        link && (!presence || presence.instanceId !== link.instanceId || runtimeSessionId !== link.runtimeSessionId)
          ? null
          : payload.presence
      io.to(`ws:${workspaceId}:stream:${streamId}`).emit("bot_runtime:presence", {
        ...payload,
        presence: streamPresence,
        streamId,
      })
    }
  }

  async function applyPresence(params: ApplyPresenceParams): Promise<BotRuntimeInstance> {
    const presence = await botRuntimeService.upsertPresenceFromBotKey({
      workspaceId: params.workspaceId,
      botId: params.botId,
      runtimeKind: params.runtimeKind,
      instanceId: params.instanceId,
      displayName: params.displayName,
      status: params.status,
      acceptingInvocations: params.acceptingInvocations,
      capabilities: {
        ...(params.capabilities ?? {}),
        ...(params.runtimeSessionId ? { runtimeSessionId: params.runtimeSessionId } : {}),
      },
      statusText: sanitizeStatusText(params.statusText),
      publicKey: params.publicKey,
      publicKeyId: params.publicKeyId,
    })
    await broadcastBotPresence(params.workspaceId, params.botId, presence)
    return presence
  }

  async function touchPresence(params: TouchPresenceParams): Promise<void> {
    try {
      const presence = await botRuntimeService.upsertPresenceFromBotKey({
        workspaceId: params.workspaceId,
        botId: params.botId,
        runtimeKind: params.runtimeKind,
        instanceId: params.instanceId,
        status: params.status,
        acceptingInvocations: params.acceptingInvocations,
        capabilities: params.runtimeSessionId ? { runtimeSessionId: params.runtimeSessionId } : undefined,
        statusText: sanitizeStatusText(params.statusText),
        mergeCapabilities: true,
        // Invocation-side touch carries no BIK; preserve the key the live
        // session registered rather than clearing it on every poll tick.
        retainBik: true,
      })
      await broadcastBotPresence(params.workspaceId, params.botId, presence)
    } catch (err) {
      logger.warn(
        { err, workspaceId: params.workspaceId, botId: params.botId },
        "Failed to update bot runtime presence"
      )
    }
  }

  async function renewClaim(params: RenewClaimParams): Promise<RenewClaimResult> {
    const renewed = await botRuntimeService.renewInvocationClaim({
      workspaceId: params.workspaceId,
      botId: params.botId,
      invocationId: params.invocationId,
      instanceId: params.instanceId,
      claimToken: params.claimToken,
      claimTtlSeconds: params.claimTtlSeconds,
    })
    if (!renewed) throw invocationClaimNotFound()
    // A claim renewal is the external runtime's liveness signal between trace
    // steps. Bot invocations reuse the invocation id as the agent session id,
    // so bump the session heartbeat too — otherwise a long-running turn that
    // renews its claim but goes longer than orphan-session-cleanup's stale
    // threshold without recording steps is falsely marked orphaned (FAILED)
    // while it is in fact alive. No-ops for session-control invocations, which
    // create no agent session.
    await AgentSessionRepository.updateHeartbeat(pool, params.invocationId)
    return {
      invocationId: renewed.id,
      status: renewed.status,
      claimExpiresAt: renewed.claimExpiresAt?.toISOString() ?? null,
    }
  }

  async function terminalizeTraceDenial(params: {
    workspaceId: string
    botId: string
    invocationId: string
    claimToken: string
    instanceId?: string
    error: unknown
  }): Promise<void> {
    const denial = params.error as { code?: string; details?: { reason?: string } }
    if (denial.code !== "STREAM_READ_ONLY" && denial.code !== "STREAM_NOT_FOUND") return
    const reason = denial.code === "STREAM_NOT_FOUND" ? "not_a_member" : (denial.details?.reason ?? "not_a_member")
    const terminalError = `STREAM_READ_ONLY:${reason}`
    const terminalized = await withTransaction(pool, async (tx) => {
      const claim = params.instanceId
        ? await botRuntimeService.findActiveClaimForUpdate(tx, {
            workspaceId: params.workspaceId,
            botId: params.botId,
            invocationId: params.invocationId,
            instanceId: params.instanceId,
            claimToken: params.claimToken,
          })
        : await botRuntimeService.findActiveClaimForUpdateByToken(tx, {
            workspaceId: params.workspaceId,
            botId: params.botId,
            invocationId: params.invocationId,
            claimToken: params.claimToken,
          })
      if (!claim) return null
      const failedClaim = await botRuntimeService.failInvocationInTransaction(tx, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        invocationId: params.invocationId,
        instanceId: params.instanceId,
        claimToken: params.claimToken,
        errorMessage: terminalError,
      })
      if (!failedClaim) return null
      const session = await AgentSessionRepository.findById(tx, claim.id)
      if (!session || session.status !== SessionStatuses.RUNNING) return null
      const stream = await StreamRepository.findById(tx, session.streamId)
      const won = await failSessionWithLifecycleInTransaction(tx, session, stream, terminalError)
      return won && stream ? { workspaceId: stream.workspaceId, sessionId: session.id } : null
    })
    if (terminalized) {
      io.to(`ws:${terminalized.workspaceId}:agent_session:${terminalized.sessionId}`).emit("agent_session:failed", {
        sessionId: terminalized.sessionId,
      })
    }
  }

  async function recordSteps(params: RecordStepsParams): Promise<RecordStepsResult> {
    let result
    try {
      result = await withTransaction(pool, async (tx) => {
        const callbackParams = {
          workspaceId: params.workspaceId,
          botId: params.botId,
          invocationId: params.invocationId,
          instanceId: params.instanceId,
          claimToken: params.claimToken,
        }
        const snapshot = await botRuntimeService.findInvocationForCallback(tx, callbackParams)
        if (!snapshot || snapshot.status !== "claimed") {
          throw invocationClaimNotFound()
        }
        // Session-control claims create no agent_sessions row (the claim handler
        // skips the insert), so appendStep below could only throw "row not found" —
        // an error-level stack per step, acked to the runtime as INTERNAL_ERROR.
        // Reject with a terminal code the runtime can treat as definitive instead.
        if (snapshot.trigger === BotInvocationTriggers.SESSION_CONTROL) {
          throw new HttpError("Session-control invocations record no trace steps", {
            status: 409,
            code: "SESSION_CONTROL_TRACE_UNSUPPORTED",
          })
        }
        await assertStreamWritable(tx, {
          workspaceId: params.workspaceId,
          streamId: snapshot.responseStreamId,
          principal: { kind: "bot", botId: params.botId },
        })
        const claim = await botRuntimeService.findActiveClaimForUpdate(tx, callbackParams)
        if (!claim || claim.responseStreamId !== snapshot.responseStreamId) {
          throw invocationClaimNotFound()
        }
        // INV-E1/INV-E7 at the plaintext step sink: a plaintext trace step must
        // never land in an E2E stream (`agent_session_steps.content` would store
        // cleartext). Sealed turns use `/sealed-steps`; the only caller that reaches
        // here on an E2E stream is a session-control invocation, which carries no
        // sealed context — its steps are best-effort, so a rejection drops cleanly.
        if (await E2eStreamsRepository.isE2eStream(tx, params.workspaceId, claim.responseStreamId)) {
          throw new HttpError("Stream is end-to-end encrypted; use the sealed-steps endpoint", {
            status: 400,
            code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
          })
        }
        const [bot, runtimePresence] = await Promise.all([
          BotRepository.findById(tx, params.workspaceId, params.botId),
          botRuntimeService.findPresenceByInstance({
            workspaceId: params.workspaceId,
            botId: params.botId,
            instanceId: params.instanceId,
          }),
        ])
        // Reject-undeclared (INV-11): a runtime that declared a manifest without
        // trace can't record steps. Unenforced for legacy (null-manifest) runtimes.
        assertManifestAllows(runtimePresence?.manifest ?? null, "trace")
        // Normalize each wire frame into AgentEvents and run them through the shared
        // TraceProjector — the same event → step state machine the in-process
        // companion and the enclave project through; only the sink (append-on-complete
        // + socket emits) is invocation-specific. One projector for the whole batch.
        const { projector, sink } = createBotInvocationTraceProjector({
          pool: tx,
          io,
          workspaceId: params.workspaceId,
          sessionId: claim.id,
          streamId: claim.responseStreamId,
          triggerMessageId: claim.sourceMessageId,
          personaName: bot?.name ?? "",
        })
        const recorded: RecordStepResult[] = []
        for (const frame of params.steps) {
          // The frames share one sink, so hand it this frame's idempotency key before
          // driving its events through the projector (today's wire writes one step per
          // frame, so a single pending value is consumed by the one `record` call).
          sink.pendingClientStepId = frame.clientStepId
          for (const event of botInvocationStepEvents({
            stepType: frame.stepType,
            content: sanitizeInvocationStepContent(frame.content),
          })) {
            await projector.handle(event)
          }
          const step = sink.lastStep
          if (!step) throw new HttpError("Failed to record step", { status: 500, code: "INTERNAL_ERROR" })
          recorded.push({ stepId: step.id, stepNumber: step.stepNumber })
        }
        // Step recording doubles as a busy heartbeat — keep the runtime's presence
        // statusText in sync with the most recent step so the runtime does not need a
        // separate presence call alongside each step. Capabilities is fully
        // overwritten on upsert, so re-supply the runtime's session id for untargeted
        // invocations; otherwise the scratchpad's session-link filter would treat the
        // runtime as stale and hide its presence mid-run.
        const persistedRuntimeSessionId =
          typeof runtimePresence?.capabilities.runtimeSessionId === "string"
            ? runtimePresence.capabilities.runtimeSessionId
            : undefined
        return {
          result: { invocationId: claim.id, sessionId: claim.id, steps: recorded },
          runtimeKind: runtimePresence?.runtimeKind ?? BotRuntimeKinds.PI_LOCAL,
          runtimeSessionId: claim.targetRuntimeSessionId ?? persistedRuntimeSessionId,
        }
      })
    } catch (error) {
      await terminalizeTraceDenial({ ...params, error })
      throw error
    }
    await touchPresence({
      workspaceId: params.workspaceId,
      botId: params.botId,
      runtimeKind: result.runtimeKind,
      instanceId: params.instanceId,
      runtimeSessionId: result.runtimeSessionId,
      status: "busy",
      acceptingInvocations: false,
      statusText: params.statusText,
    })
    return result.result
  }

  async function recordSealedSteps(params: RecordSealedStepsParams): Promise<RecordSealedStepsResult> {
    try {
      return await withTransaction(pool, async (tx) => {
        const callbackParams = {
          workspaceId: params.workspaceId,
          botId: params.botId,
          invocationId: params.invocationId,
          claimToken: params.callbackToken,
        }
        const snapshot = await botRuntimeService.findInvocationForCallback(tx, callbackParams)
        if (!snapshot || snapshot.status !== "claimed") {
          throw invocationClaimNotFound()
        }
        const ctx = await authorizeSealedCallback(tx, {
          workspaceId: params.workspaceId,
          botId: params.botId,
          invocationId: params.invocationId,
          callbackToken: params.callbackToken,
        })
        if (ctx.session.streamId !== snapshot.responseStreamId) {
          throw invocationClaimNotFound()
        }
        await assertStreamWritable(tx, {
          workspaceId: params.workspaceId,
          streamId: snapshot.responseStreamId,
          principal: { kind: "bot", botId: params.botId },
        })
        const claim = await botRuntimeService.findActiveClaimForUpdateByToken(tx, callbackParams)
        if (!claim || claim.responseStreamId !== snapshot.responseStreamId) {
          throw invocationClaimNotFound()
        }
        const recorded: RecordStepResult[] = []
        for (const frame of params.steps) {
          const step = await finalizeSealedStep({ pool: tx, io }, ctx, frame)
          recorded.push({ stepId: step.id, stepNumber: step.stepNumber })
        }
        // Sealed steps are the turn's liveness signal between claim renewals, the
        // same as the enclave's step callbacks — bump the session heartbeat so a
        // long chatty turn is never falsely orphan-failed. No presence touch: the
        // header-auth model carries no instanceId to key a presence row by, and the
        // harness's own presence loop covers it.
        await AgentSessionRepository.updateHeartbeat(tx, ctx.session.id)
        return { invocationId: ctx.session.id, sessionId: ctx.session.id, steps: recorded }
      })
    } catch (error) {
      await terminalizeTraceDenial({
        workspaceId: params.workspaceId,
        botId: params.botId,
        invocationId: params.invocationId,
        claimToken: params.callbackToken,
        error,
      })
      throw error
    }
  }

  return { applyPresence, touchPresence, renewClaim, recordSteps, recordSealedSteps }
}
