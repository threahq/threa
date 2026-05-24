import { describe, expect, test, spyOn, afterEach } from "bun:test"
import type { Pool } from "pg"
import { HttpError } from "../../lib/errors"
import { UserRepository } from "../workspaces"
import { UserPreferencesService } from "../user-preferences"
import { VoiceTranscriptionService } from "./service"
import { VoiceSessionRepository, type VoiceSessionRow } from "./repository"
import { voiceConfig } from "./config"
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from "@threa/types"

const pool = {} as Pool

const userPreferencesService = new UserPreferencesService(pool)

function makePrefs(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    workspaceId: "ws_1",
    userId: "user_1",
    ...DEFAULT_USER_PREFERENCES,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeRow(overrides: Partial<VoiceSessionRow> = {}): VoiceSessionRow {
  return {
    id: "voicesess_1",
    workspaceId: "ws_1",
    userId: "user_1",
    model: "elevenlabs:scribe-v2-realtime",
    provider: "elevenlabs",
    region: "us",
    language: null,
    status: "active",
    totalAudioMs: 0,
    createdAt: new Date(),
    finishedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  }
}

afterEach(() => {
  // Bun restores spies created with spyOn at the end of each test file scope,
  // but restore explicitly so cross-test leakage can't happen.
  ;(VoiceSessionRepository.insert as ReturnType<typeof spyOn>)?.mockRestore?.()
  ;(VoiceSessionRepository.findOwned as ReturnType<typeof spyOn>)?.mockRestore?.()
  ;(VoiceSessionRepository.finalizeOwned as ReturnType<typeof spyOn>)?.mockRestore?.()
  ;(VoiceSessionRepository.expireStale as ReturnType<typeof spyOn>)?.mockRestore?.()
  ;(UserRepository.findByWorkosUserIdInWorkspace as ReturnType<typeof spyOn>)?.mockRestore?.()
  ;(userPreferencesService.getPreferences as ReturnType<typeof spyOn>)?.mockRestore?.()
})

describe("VoiceTranscriptionService.createSession", () => {
  test("falls back to the configured default when neither the caller nor the user pref names a model", async () => {
    const insert = spyOn(VoiceSessionRepository, "insert").mockResolvedValue(makeRow())
    spyOn(userPreferencesService, "getPreferences").mockResolvedValue(makePrefs())
    const service = new VoiceTranscriptionService(pool, userPreferencesService)

    const before = Date.now()
    await service.createSession({ workspaceId: "ws_1", userId: "user_1" })

    expect(insert).toHaveBeenCalledTimes(1)
    const arg = insert.mock.calls[0][1]
    expect(arg.model).toBe(voiceConfig.defaultModel)
    expect(arg.provider).toBe("elevenlabs")
    expect(arg.region).toBe("us")
    expect(arg.language).toBeNull()
    expect(arg.expiresAt.getTime()).toBeGreaterThanOrEqual(before + voiceConfig.maxSessionMs)
  })

  test("uses the user's voiceTranscriptionModel preference when the caller does not pass one", async () => {
    const insert = spyOn(VoiceSessionRepository, "insert").mockResolvedValue(makeRow({ model: "deepgram:nova-3" }))
    spyOn(userPreferencesService, "getPreferences").mockResolvedValue(
      makePrefs({ voiceTranscriptionModel: "deepgram:nova-3" })
    )
    const service = new VoiceTranscriptionService(pool, userPreferencesService)

    await service.createSession({ workspaceId: "ws_1", userId: "user_1" })

    const arg = insert.mock.calls[0][1]
    expect(arg.model).toBe("deepgram:nova-3")
    expect(arg.provider).toBe("deepgram")
  })

  test("an explicit model wins over the user preference and skips the prefs lookup", async () => {
    const insert = spyOn(VoiceSessionRepository, "insert").mockResolvedValue(makeRow())
    const getPrefs = spyOn(userPreferencesService, "getPreferences")
    const service = new VoiceTranscriptionService(pool, userPreferencesService)

    await service.createSession({ workspaceId: "ws_1", userId: "user_1", model: "deepgram:nova-3", language: "en" })

    const arg = insert.mock.calls[0][1]
    expect(arg.model).toBe("deepgram:nova-3")
    expect(arg.provider).toBe("deepgram")
    expect(arg.language).toBe("en")
    expect(getPrefs).not.toHaveBeenCalled()
  })

  test("rejects a model without a provider prefix", async () => {
    spyOn(VoiceSessionRepository, "insert").mockResolvedValue(makeRow())
    const service = new VoiceTranscriptionService(pool, userPreferencesService)

    const promise = service.createSession({ workspaceId: "ws_1", userId: "user_1", model: "no-colon" })
    await expect(promise).rejects.toMatchObject({ status: 400, code: "INVALID_VOICE_MODEL" })
    await expect(promise).rejects.toBeInstanceOf(HttpError)
  })
})

describe("VoiceTranscriptionService.getRelaySession", () => {
  const params = { workspaceId: "ws_1", workosUserId: "workos_1", sessionId: "voicesess_1" }

  function mockUser() {
    spyOn(UserRepository, "findByWorkosUserIdInWorkspace").mockResolvedValue({ id: "user_1" } as never)
  }

  test("resolves the workspace user and returns the row when active and unexpired", async () => {
    mockUser()
    const row = makeRow()
    const findOwned = spyOn(VoiceSessionRepository, "findOwned").mockResolvedValue(row)
    const service = new VoiceTranscriptionService(pool, userPreferencesService)
    expect(await service.getRelaySession(params)).toBe(row)
    // The session lookup is scoped to the resolved workspace user id, not the
    // raw WorkOS id from the socket.
    expect(findOwned.mock.calls[0]).toEqual([pool, "ws_1", "user_1", "voicesess_1"])
  })

  test("throws 403 when the WorkOS user is not a member of the workspace", async () => {
    spyOn(UserRepository, "findByWorkosUserIdInWorkspace").mockResolvedValue(null)
    const findOwned = spyOn(VoiceSessionRepository, "findOwned")
    const service = new VoiceTranscriptionService(pool, userPreferencesService)
    await expect(service.getRelaySession(params)).rejects.toMatchObject({
      status: 403,
      code: "VOICE_NOT_AUTHORIZED",
    })
    expect(findOwned).not.toHaveBeenCalled()
  })

  test("throws 404 when not found", async () => {
    mockUser()
    spyOn(VoiceSessionRepository, "findOwned").mockResolvedValue(null)
    const service = new VoiceTranscriptionService(pool, userPreferencesService)
    await expect(service.getRelaySession(params)).rejects.toMatchObject({
      status: 404,
      code: "VOICE_SESSION_NOT_FOUND",
    })
  })

  test("throws 409 when not active", async () => {
    mockUser()
    spyOn(VoiceSessionRepository, "findOwned").mockResolvedValue(makeRow({ status: "finished" }))
    const service = new VoiceTranscriptionService(pool, userPreferencesService)
    await expect(service.getRelaySession(params)).rejects.toMatchObject({
      status: 409,
      code: "VOICE_SESSION_NOT_ACTIVE",
    })
  })

  test("throws 409 when expired", async () => {
    mockUser()
    spyOn(VoiceSessionRepository, "findOwned").mockResolvedValue(makeRow({ expiresAt: new Date(Date.now() - 1) }))
    const service = new VoiceTranscriptionService(pool, userPreferencesService)
    await expect(service.getRelaySession(params)).rejects.toMatchObject({
      status: 409,
      code: "VOICE_SESSION_EXPIRED",
    })
  })
})

describe("VoiceTranscriptionService finalize paths", () => {
  const params = { workspaceId: "ws_1", userId: "user_1", sessionId: "voicesess_1", totalAudioMs: 1234 }

  test("finishSession transitions with status finished", async () => {
    const finalize = spyOn(VoiceSessionRepository, "finalizeOwned").mockResolvedValue("ok")
    const service = new VoiceTranscriptionService(pool, userPreferencesService)
    await service.finishSession(params)
    expect(finalize.mock.calls[0][1]).toMatchObject({ status: "finished", totalAudioMs: 1234, id: "voicesess_1" })
  })

  test("abortSession defaults totalAudioMs to 0 and uses status aborted", async () => {
    const finalize = spyOn(VoiceSessionRepository, "finalizeOwned").mockResolvedValue("ok")
    const service = new VoiceTranscriptionService(pool, userPreferencesService)
    await service.abortSession({ workspaceId: "ws_1", userId: "user_1", sessionId: "voicesess_1" })
    expect(finalize.mock.calls[0][1]).toMatchObject({ status: "aborted", totalAudioMs: 0 })
  })

  test("throws 404 when the session does not exist", async () => {
    spyOn(VoiceSessionRepository, "finalizeOwned").mockResolvedValue("not_found")
    const service = new VoiceTranscriptionService(pool, userPreferencesService)
    await expect(service.finishSession(params)).rejects.toMatchObject({
      status: 404,
      code: "VOICE_SESSION_NOT_FOUND",
    })
  })

  test("treats already_final as an idempotent no-op", async () => {
    spyOn(VoiceSessionRepository, "finalizeOwned").mockResolvedValue("already_final")
    const service = new VoiceTranscriptionService(pool, userPreferencesService)
    await expect(service.finishSession(params)).resolves.toBeUndefined()
  })
})

describe("VoiceTranscriptionService.expireStaleSessions", () => {
  test("sweeps with the current time and returns the swept count", async () => {
    const expireStale = spyOn(VoiceSessionRepository, "expireStale").mockResolvedValue(3)
    const service = new VoiceTranscriptionService(pool, userPreferencesService)

    const before = Date.now()
    expect(await service.expireStaleSessions()).toBe(3)

    expect(expireStale.mock.calls[0][0]).toBe(pool)
    const now = expireStale.mock.calls[0][1] as Date
    expect(now.getTime()).toBeGreaterThanOrEqual(before)
  })
})
