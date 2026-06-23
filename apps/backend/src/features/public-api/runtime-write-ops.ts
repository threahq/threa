import type { Pool } from "pg"
import type { Server } from "socket.io"
import { HttpError } from "@threa/backend-common"
import { BotRuntimeKinds } from "@threa/types"
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
} from "../bot-runtimes"
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
    if (!renewed) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
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

  return { applyPresence, touchPresence, renewClaim, recordSteps }
}
