import type { Pool } from "pg"
import { HttpError } from "../../lib/errors"
import { voiceSessionId } from "../../lib/id"
import { UserRepository } from "../workspaces"
import { UserPreferencesService } from "../user-preferences"
import { VoiceSessionRepository, type VoiceSessionRow } from "./repository"
import { voiceConfig, parseModelProvider, type VoiceSessionStatus } from "./config"

export class VoiceTranscriptionService {
  constructor(
    private pool: Pool,
    private userPreferencesService: UserPreferencesService
  ) {}

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
   * owned by that user; throws otherwise. Identity resolution lives here, not
   * in the gateway, so session data access stays behind the service (INV-34).
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
    return VoiceSessionRepository.expireStale(this.pool, now)
  }

  private async finalize(params: {
    workspaceId: string
    userId: string
    sessionId: string
    totalAudioMs: number
    status: Extract<VoiceSessionStatus, "finished" | "aborted" | "expired">
  }): Promise<void> {
    const result = await VoiceSessionRepository.finalizeOwned(this.pool, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      id: params.sessionId,
      status: params.status,
      totalAudioMs: params.totalAudioMs,
    })
    if (result === "not_found") {
      throw new HttpError("Voice session not found", { status: 404, code: "VOICE_SESSION_NOT_FOUND" })
    }
    // "already_final" is idempotent for finish/abort — the session is already
    // closed (e.g. the gateway hit the max-duration guard first). Not an error.
  }
}
