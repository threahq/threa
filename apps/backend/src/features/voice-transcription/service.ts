import type { Pool } from "pg"
import { HttpError } from "../../lib/errors"
import { voiceSessionId } from "../../lib/id"
import { VoiceSessionRepository, type VoiceSessionRow } from "./repository"
import { voiceConfig, type VoiceSessionStatus } from "./config"

function parseProvider(model: string): string {
  const colon = model.indexOf(":")
  if (colon === -1) {
    throw new HttpError(`Invalid voice model: ${model}`, { status: 400, code: "INVALID_VOICE_MODEL" })
  }
  return model.slice(0, colon)
}

export class VoiceTranscriptionService {
  private pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  /**
   * Create an active dictation session. Provider is derived from the model
   * prefix; region is fixed to `us` for the PR1 skeleton — the residency
   * resolver that may route elsewhere (e.g. Deepgram-EU) lands in PR5.
   */
  async createSession(params: {
    workspaceId: string
    userId: string
    model?: string
    language?: string
  }): Promise<VoiceSessionRow> {
    const model = params.model ?? voiceConfig.defaultModel
    const provider = parseProvider(model)
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
   * Resolve a session for the realtime relay: it must exist, be active, and be
   * owned by the connecting user in this workspace. Throws otherwise so the
   * gateway can refuse to open an upstream socket for a stale/foreign session.
   */
  async getRelaySession(params: { workspaceId: string; userId: string; sessionId: string }): Promise<VoiceSessionRow> {
    const row = await VoiceSessionRepository.findOwned(this.pool, params.workspaceId, params.userId, params.sessionId)
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
