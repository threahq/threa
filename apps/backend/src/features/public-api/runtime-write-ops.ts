import type { Pool, PoolClient } from "pg"
import { withClient } from "../../db"
import type { Server } from "socket.io"
import { withTransaction } from "../../db"
import { HttpError } from "@threa/backend-common"
import { invocationClaimNotFound } from "./errors"
import {
  BotInvocationTriggers,
  BotRuntimeKinds,
  type BotInvocationCancellationReason,
  type InvocationInputUpdateWire,
} from "@threa/types"
import { resolveDeliveryVerdict, TrustTiers } from "@threa/agent-runtime"
import {
  assertManifestAllows,
  type BotInvocation,
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
  resolveRuntimeKindConfig,
} from "../bot-runtimes"
import { authorizeSealedCallback, finalizeSealedStep } from "./sealed-callbacks"
import { E2eStreamsRepository, StreamE2eKeyWrapsRepository, resolveSealingContext } from "../e2e-streams"
import { MessageRepository } from "../messaging"
import { BotRuntimeInstanceRepository } from "../bot-runtimes"
import { buildSealedInputUpdate } from "./sealed-turn-context"
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

function cancelledRenewal(invocation: BotInvocation, reason: BotInvocationCancellationReason): RenewClaimResult {
  return {
    invocationId: invocation.id,
    status: "cancelled",
    claimExpiresAt: null,
    sourceRevision: invocation.sourceMessageRevision,
    reason,
  }
}

async function withRenewalSerializationRetry<T>(pool: Pool, operation: (db: PoolClient) => Promise<T>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withClient(pool, operation)
    } catch (error) {
      if ((error as { code?: string }).code !== "40001" || attempt === 2) throw error
    }
  }
  throw new Error("Invocation renewal retry exhausted without a result")
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
    // Skip the link lookup when there's no presence or the runtime kind can't
    // have linked sessions.
    const links =
      presence && resolveRuntimeKindConfig(presence.runtimeKind).sessionLinking !== "none"
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
      manifest: params.manifest ?? null,
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
        retainManifest: true,
      })
      await broadcastBotPresence(params.workspaceId, params.botId, presence)
    } catch (err) {
      logger.warn(
        { err, workspaceId: params.workspaceId, botId: params.botId },
        "Failed to update bot runtime presence"
      )
    }
  }

  /** The cancellation is the response, so it must outlive the renewal transaction. */
  async function commitKeyGrantLossCancellation(db: PoolClient, control: BotInvocation): Promise<RenewClaimResult> {
    const cancelled = await botRuntimeService.cancelOwnedClaimForKeyGrantLossInTransaction(db, control)
    if (!cancelled) throw invocationClaimNotFound()
    await db.query("COMMIT")
    return cancelledRenewal(cancelled, "key_grant_lost")
  }

  async function renewClaim(params: RenewClaimParams): Promise<RenewClaimResult> {
    const result = await withRenewalSerializationRetry(pool, async (db) => {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ")
      try {
        const renewed = await botRuntimeService.renewInvocationClaimInTransaction(db, params)
        if (!renewed) throw invocationClaimNotFound()
        if (renewed.status === "cancelled") {
          await db.query("COMMIT")
          return cancelledRenewal(renewed, renewed.cancellationReason ?? "routing_changed")
        }

        let update: InvocationInputUpdateWire | undefined
        const sealing = await resolveSealingContext(db, {
          workspaceId: renewed.workspaceId,
          streamId: renewed.activeStreamId,
          actor: { kind: "bot", botId: renewed.actorId },
        })
        const verdict = resolveDeliveryVerdict({ trust: TrustTiers.THIRD_PARTY, sealing })
        if (verdict.delivery === "denied") return await commitKeyGrantLossCancellation(db, renewed)
        const needsUpdate =
          params.knownSourceRevision != null && params.knownSourceRevision < renewed.sourceMessageRevision
        if (needsUpdate && verdict.delivery === "plaintext") {
          update = {
            delivery: "plaintext",
            sourceRevision: renewed.sourceMessageRevision,
            promptMarkdown: renewed.promptMarkdown,
            mentionedActorSlugs: renewed.mentionedActorSlugs,
          }
        } else if (needsUpdate) {
          const instance = await BotRuntimeInstanceRepository.findByInstance(db, {
            workspaceId: renewed.workspaceId,
            botId: renewed.actorId,
            instanceId: params.instanceId,
          })
          const e2e = await E2eStreamsRepository.getByStreamId(db, renewed.workspaceId, renewed.rootStreamId)
          const wraps = await StreamE2eKeyWrapsRepository.listForStream(db, renewed.workspaceId, renewed.rootStreamId)
          const trigger = await MessageRepository.findInvocationSourceStateForShare(db, {
            workspaceId: renewed.workspaceId,
            messageId: renewed.sourceMessageId,
          })
          if (
            !trigger ||
            trigger.deleted ||
            trigger.streamId !== renewed.activeStreamId ||
            trigger.revision !== renewed.sourceMessageRevision
          ) {
            throw new HttpError("Invocation control state changed; retry renewal", {
              status: 409,
              code: "INVOCATION_CONTROL_RETRY",
            })
          }
          const sealedUpdate =
            instance?.publicKeyId && e2e
              ? (buildSealedInputUpdate({
                  e2e,
                  bikKeyId: instance.publicKeyId,
                  wraps,
                  trigger,
                  replySenderId: renewed.actorId,
                  sourceRevision: renewed.sourceMessageRevision,
                }) ?? undefined)
              : undefined
          if (!sealedUpdate) return await commitKeyGrantLossCancellation(db, renewed)
          update = sealedUpdate
          const updatedSession = await AgentSessionRepository.updateInvocationReplyKeyGeneration(db, {
            workspaceId: renewed.workspaceId,
            invocationId: renewed.id,
            replyKeyGeneration: sealedUpdate.reply.keyGeneration,
          })
          if (!updatedSession) {
            throw new HttpError("Invocation session not found", { status: 409, code: "INVOCATION_CONTROL_RETRY" })
          }
        }
        await db.query("COMMIT")
        return {
          invocationId: renewed.id,
          status: "active" as const,
          claimExpiresAt: renewed.claimExpiresAt!.toISOString(),
          sourceRevision: renewed.sourceMessageRevision,
          ...(update ? { update } : {}),
        }
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {})
        throw error
      }
    })
    await AgentSessionRepository.updateHeartbeat(pool, params.invocationId)
    return result
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
