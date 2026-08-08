import type { Pool } from "pg"
import { withClient } from "../../db"
import type { Server } from "socket.io"
import { HttpError } from "@threa/backend-common"
import { BotRuntimeKinds, type InvocationInputUpdateWire } from "@threa/types"
import { resolveDeliveryVerdict, TrustTiers } from "@threa/agent-runtime"
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
import { E2eStreamsRepository, StreamE2eKeyWrapsRepository, resolveSealingContext } from "../e2e-streams"
import { MessageRepository } from "../messaging"
import { BotRuntimeInstanceRepository } from "../bot-runtimes"
import { buildSealedInputUpdate } from "./sealed-turn-context"
import { BotChannelAccessRepository, type BotChannelService } from "../api-keys"
import { AgentSessionRepository } from "../agents"
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

  async function renewClaim(params: RenewClaimParams): Promise<RenewClaimResult> {
    const result = await withClient(pool, async (db) => {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ")
      try {
        const renewed = await botRuntimeService.renewInvocationClaimInTransaction(db, params)
        if (!renewed) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
        if (renewed.status === "cancelled") {
          await db.query("COMMIT")
          return {
            invocationId: renewed.id,
            status: "cancelled" as const,
            sourceRevision: renewed.sourceMessageRevision,
            reason: renewed.cancellationReason ?? "routing_changed",
          }
        }

        let update: InvocationInputUpdateWire | undefined
        const sealing = await resolveSealingContext(db, {
          workspaceId: renewed.workspaceId,
          streamId: renewed.activeStreamId,
          actor: { kind: "bot", botId: renewed.actorId },
        })
        const verdict = resolveDeliveryVerdict({ trust: TrustTiers.THIRD_PARTY, sealing })
        if (verdict.delivery === "denied") {
          const cancelled = await botRuntimeService.cancelOwnedClaimForKeyGrantLossInTransaction(db, renewed)
          if (!cancelled) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
          await db.query("COMMIT")
          return {
            invocationId: cancelled.id,
            status: "cancelled" as const,
            sourceRevision: cancelled.sourceMessageRevision,
            reason: "key_grant_lost" as const,
          }
        }
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
          if (!sealedUpdate) {
            const cancelled = await botRuntimeService.cancelOwnedClaimForKeyGrantLossInTransaction(db, renewed)
            if (!cancelled) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
            await db.query("COMMIT")
            return {
              invocationId: cancelled.id,
              status: "cancelled" as const,
              sourceRevision: cancelled.sourceMessageRevision,
              reason: "key_grant_lost" as const,
            }
          }
          if (sealedUpdate.delivery !== "sealed") throw new Error("Expected sealed invocation input update")
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

  async function recordSteps(params: RecordStepsParams): Promise<RecordStepsResult> {
    const claim = await botRuntimeService.findActiveClaim({
      workspaceId: params.workspaceId,
      botId: params.botId,
      invocationId: params.invocationId,
      instanceId: params.instanceId,
      claimToken: params.claimToken,
    })
    if (!claim) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
    const accessible = await botChannelService.isStreamAccessibleForBot(
      params.workspaceId,
      params.botId,
      claim.responseStreamId
    )
    if (!accessible) throw new HttpError("Stream not accessible", { status: 403, code: "FORBIDDEN" })
    // INV-E1/INV-E7 at the plaintext step sink: a plaintext trace step must
    // never land in an E2E stream (`agent_session_steps.content` would store
    // cleartext). Sealed turns use `/sealed-steps`; the only caller that reaches
    // here on an E2E stream is a session-control invocation, which carries no
    // sealed context — its steps are best-effort, so a rejection drops cleanly.
    if (await E2eStreamsRepository.isE2eStream(pool, params.workspaceId, claim.responseStreamId)) {
      throw new HttpError("Stream is end-to-end encrypted; use the sealed-steps endpoint", {
        status: 400,
        code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
      })
    }
    const [bot, runtimePresence] = await Promise.all([
      BotRepository.findById(pool, params.workspaceId, params.botId),
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
      pool,
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
    await touchPresence({
      workspaceId: params.workspaceId,
      botId: params.botId,
      runtimeKind: runtimePresence?.runtimeKind ?? BotRuntimeKinds.PI_LOCAL,
      instanceId: params.instanceId,
      runtimeSessionId: claim.targetRuntimeSessionId ?? persistedRuntimeSessionId,
      status: "busy",
      acceptingInvocations: false,
      statusText: params.statusText,
    })
    return { invocationId: claim.id, sessionId: claim.id, steps: recorded }
  }

  async function recordSealedSteps(params: RecordSealedStepsParams): Promise<RecordSealedStepsResult> {
    const ctx = await authorizeSealedCallback(pool, {
      workspaceId: params.workspaceId,
      botId: params.botId,
      invocationId: params.invocationId,
      callbackToken: params.callbackToken,
    })
    const recorded: RecordStepResult[] = []
    for (const frame of params.steps) {
      const step = await finalizeSealedStep({ pool, io }, ctx, frame)
      recorded.push({ stepId: step.id, stepNumber: step.stepNumber })
    }
    // Sealed steps are the turn's liveness signal between claim renewals, the
    // same as the enclave's step callbacks — bump the session heartbeat so a
    // long chatty turn is never falsely orphan-failed. No presence touch: the
    // header-auth model carries no instanceId to key a presence row by, and the
    // harness's own presence loop covers it.
    await AgentSessionRepository.updateHeartbeat(pool, ctx.session.id)
    return { invocationId: ctx.session.id, sessionId: ctx.session.id, steps: recorded }
  }

  return { applyPresence, touchPresence, renewClaim, recordSteps, recordSealedSteps }
}
