import type { Pool, PoolClient } from "pg"
import { AISpendDeniedError, parseModelId, type ModelRegistry, type SpendGate } from "@threahq/agent-runtime"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { voiceSessionId } from "../../lib/id"
import { logger } from "../../lib/logger"
import type { AICostService } from "../ai-usage"
import { UserRepository } from "../workspaces"
import { UserPreferencesService } from "../user-preferences"
import { VoiceSessionRepository, type VoiceSessionRow } from "./repository"
import { voiceConfig, parseModelProvider, type VoiceSessionStatus } from "./config"

export const VOICE_TRANSCRIPTION_FUNCTION_ID = "voice-transcription-realtime"

export interface VoiceTranscriptionServiceDeps {
  pool: Pool
  userPreferencesService: UserPreferencesService
  spendGate: SpendGate
  costService: Pick<AICostService, "recordUsageInTransaction">
  modelRegistry: Pick<ModelRegistry, "getAudioPricePerHour">
}

export class VoiceTranscriptionService {
  private readonly pool: Pool
  private readonly userPreferencesService: UserPreferencesService
  private readonly spendGate: SpendGate
  private readonly costService: Pick<AICostService, "recordUsageInTransaction">
  private readonly modelRegistry: Pick<ModelRegistry, "getAudioPricePerHour">

  constructor(deps: VoiceTranscriptionServiceDeps) {
    this.pool = deps.pool
    this.userPreferencesService = deps.userPreferencesService
    this.spendGate = deps.spendGate
    this.costService = deps.costService
    this.modelRegistry = deps.modelRegistry
  }

  /**
   * Create an active dictation session; provider is derived from the model prefix.
   * Model resolution order: explicit `params.model` → the user's
   * `voiceTranscriptionModel` preference → the configured default.
   */
  async createSession(params: {
    workspaceId: string
    userId: string
    model?: string
    language?: string
  }): Promise<VoiceSessionRow> {
    let model = params.model
    if (!model) {
      const prefs = await this.userPreferencesService.getPreferences(params.workspaceId, params.userId)
      model = prefs.voiceTranscriptionModel ?? voiceConfig.defaultModel
    }
    const provider = parseModelProvider(model)
    if (!provider) {
      throw new HttpError(`Invalid voice model: ${model}`, { status: 400, code: "INVALID_VOICE_MODEL" })
    }
    const region = "us"
    const expiresAt = new Date(Date.now() + voiceConfig.maxSessionMs)

    return VoiceSessionRepository.insert(this.pool, {
      id: voiceSessionId(),
      workspaceId: params.workspaceId,
      userId: params.userId,
      model,
      provider,
      region,
      language: params.language ?? null,
      expiresAt,
    })
  }

  /**
   * Resolve a session for the realtime relay: the WorkOS user must map to a
   * member of this workspace, and the session must exist, be active, and be
   * owned by that user, and the spend gate must admit the transcription;
   * throws otherwise (`AISpendDeniedError` for a spend denial). Identity
   * resolution lives here, not in the gateway, so session data access stays
   * behind the service (INV-34).
   */
  async getRelaySession(params: {
    workspaceId: string
    workosUserId: string
    sessionId: string
  }): Promise<VoiceSessionRow> {
    const workspaceUser = await UserRepository.findByWorkosUserIdInWorkspace(
      this.pool,
      params.workspaceId,
      params.workosUserId
    )
    if (!workspaceUser) {
      throw new HttpError("Not authorized for this workspace", { status: 403, code: "VOICE_NOT_AUTHORIZED" })
    }
    const row = await VoiceSessionRepository.findOwned(
      this.pool,
      params.workspaceId,
      workspaceUser.id,
      params.sessionId
    )
    if (!row) {
      throw new HttpError("Voice session not found", { status: 404, code: "VOICE_SESSION_NOT_FOUND" })
    }
    if (row.status !== "active") {
      throw new HttpError("Voice session is not active", { status: 409, code: "VOICE_SESSION_NOT_ACTIVE" })
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new HttpError("Voice session has expired", { status: 409, code: "VOICE_SESSION_EXPIRED" })
    }
    const admission = { workspaceId: row.workspaceId, userId: row.userId, functionId: VOICE_TRANSCRIPTION_FUNCTION_ID }
    const decision = await this.spendGate.admit(admission)
    if (!decision.allowed) throw new AISpendDeniedError(admission, decision.reason)
    return row
  }

  async finishSession(params: {
    workspaceId: string
    userId: string
    sessionId: string
    totalAudioMs: number
  }): Promise<void> {
    await this.finalize({ ...params, status: "finished" })
  }

  async abortSession(params: {
    workspaceId: string
    userId: string
    sessionId: string
    totalAudioMs?: number
  }): Promise<void> {
    await this.finalize({
      workspaceId: params.workspaceId,
      userId: params.userId,
      sessionId: params.sessionId,
      totalAudioMs: params.totalAudioMs ?? 0,
      status: "aborted",
    })
  }

  /**
   * Expire sessions left `active` past their hard `expires_at`. The gateway's
   * in-process max-duration timer finalizes the common case; this is the
   * safety net the periodic sweeper drives for sessions a crash/restart (or an
   * HTTP-created session whose socket never connected) stranded active. Status
   * transitions stay behind the service (INV-34). Returns how many were swept.
   */
  async expireStaleSessions(now: Date = new Date()): Promise<number> {
    return VoiceSessionRepository.expireStale(this.pool, new Date(now.getTime() - voiceConfig.expirySweepGraceMs))
  }

  private async finalize(params: {
    workspaceId: string
    userId: string
    sessionId: string
    totalAudioMs: number
    status: Extract<VoiceSessionStatus, "finished" | "aborted" | "expired">
  }): Promise<void> {
    const result = await withTransaction(this.pool, async (tx) => {
      const outcome = await VoiceSessionRepository.finalizeOwned(tx, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        id: params.sessionId,
        status: params.status,
        totalAudioMs: params.totalAudioMs,
      })
      // Only the call that wins the active→terminal transition records, so a
      // racing finish/abort or a repeat can never bill the same audio twice.
      if (outcome === "ok") await this.recordTranscriptionCost(tx, params)
      return outcome
    })
    if (result === "not_found") {
      throw new HttpError("Voice session not found", { status: 404, code: "VOICE_SESSION_NOT_FOUND" })
    }
    // "already_final" is idempotent for finish/abort — the session is already
    // closed (e.g. the gateway hit the max-duration guard first). Not an error.
  }

  private async recordTranscriptionCost(
    tx: PoolClient,
    params: { workspaceId: string; userId: string; sessionId: string; totalAudioMs: number }
  ): Promise<void> {
    if (params.totalAudioMs <= 0) return
    const row = await VoiceSessionRepository.findOwned(tx, params.workspaceId, params.userId, params.sessionId)
    if (!row) throw new Error(`Voice session ${params.sessionId} vanished inside its finalize transaction`)
    const pricePerHour = this.modelRegistry.getAudioPricePerHour(row.model)
    if (pricePerHour === undefined) {
      logger.error(
        { workspaceId: row.workspaceId, sessionId: row.id, model: row.model, totalAudioMs: params.totalAudioMs },
        "Voice model has no audio price; transcription cost NOT recorded"
      )
      return
    }
    await this.costService.recordUsageInTransaction(tx, {
      workspaceId: row.workspaceId,
      userId: row.userId,
      sessionId: row.id,
      functionId: VOICE_TRANSCRIPTION_FUNCTION_ID,
      model: parseModelId(row.model).modelId,
      provider: row.provider,
      origin: "user",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: (params.totalAudioMs / 3_600_000) * pricePerHour,
      },
      metadata: { totalAudioMs: params.totalAudioMs },
    })
  }
}
