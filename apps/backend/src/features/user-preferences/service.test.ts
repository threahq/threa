import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { DEFAULT_BOARD_LEDGER_ROWS } from "@threa/types"
import { UserPreferencesService } from "./service"
import { UserPreferencesRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { PersonaRepository } from "../agents"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const USER_ID = "usr_1"

function setupTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

describe("UserPreferencesService.updatePreferences defaultCompanionPersonaId", () => {
  afterEach(() => mock.restore())

  it("stores an active persona id as an override", async () => {
    setupTransaction()
    const findById = spyOn(PersonaRepository, "findById").mockResolvedValue({ status: "active" } as any)
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([
      { key: "defaultCompanionPersonaId", value: "persona_x" },
    ])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    const prefs = await service.updatePreferences(WORKSPACE_ID, USER_ID, { defaultCompanionPersonaId: "persona_x" })

    expect(findById).toHaveBeenCalledWith({}, "persona_x", WORKSPACE_ID)
    expect(bulkSet).toHaveBeenCalledWith({}, USER_ID, [{ key: "defaultCompanionPersonaId", value: "persona_x" }])
    expect(bulkDelete).not.toHaveBeenCalled()
    expect(prefs.defaultCompanionPersonaId).toBe("persona_x")
  })

  it("rejects an archived persona id with a 400", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue({ status: "archived" } as any)
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const service = new UserPreferencesService({} as any)

    await expect(
      service.updatePreferences(WORKSPACE_ID, USER_ID, { defaultCompanionPersonaId: "persona_x" })
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_AVAILABLE" })
    expect(bulkSet).not.toHaveBeenCalled()
  })

  it("rejects an id not resolvable in this workspace with a 400", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue(null)
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const service = new UserPreferencesService({} as any)

    await expect(
      service.updatePreferences(WORKSPACE_ID, USER_ID, { defaultCompanionPersonaId: "persona_other_ws" })
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_AVAILABLE" })
    expect(bulkSet).not.toHaveBeenCalled()
  })

  it("clears the override on null without a persona lookup", async () => {
    setupTransaction()
    const findById = spyOn(PersonaRepository, "findById").mockResolvedValue({ status: "active" } as any)
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    await service.updatePreferences(WORKSPACE_ID, USER_ID, { defaultCompanionPersonaId: null })

    // null equals the default, so it is a delete, not a store — and no lookup runs.
    expect(findById).not.toHaveBeenCalled()
    expect(bulkDelete).toHaveBeenCalledWith({}, USER_ID, ["defaultCompanionPersonaId"])
    expect(bulkSet).not.toHaveBeenCalled()
  })
})

describe("UserPreferencesService.updatePreferences mobile inline attachments", () => {
  afterEach(() => mock.restore())

  it("stores the disabled override", async () => {
    setupTransaction()
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([
      { key: "mobileInlineAttachments", value: false },
    ])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    const prefs = await service.updatePreferences(WORKSPACE_ID, USER_ID, { mobileInlineAttachments: false })

    expect(bulkSet).toHaveBeenCalledWith({}, USER_ID, [{ key: "mobileInlineAttachments", value: false }])
    expect(bulkDelete).not.toHaveBeenCalled()
    expect(prefs.mobileInlineAttachments).toBe(false)
  })
})

describe("UserPreferencesService.updatePreferences analyticsConsent", () => {
  afterEach(() => mock.restore())

  it("should store the granted override when analyticsConsent is updated", async () => {
    setupTransaction()
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([{ key: "analyticsConsent", value: "granted" }])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    const prefs = await service.updatePreferences(WORKSPACE_ID, USER_ID, { analyticsConsent: "granted" })

    expect(bulkSet).toHaveBeenCalledWith({}, USER_ID, [{ key: "analyticsConsent", value: "granted" }])
    expect(bulkDelete).not.toHaveBeenCalled()
    expect(prefs.analyticsConsent).toBe("granted")
  })

  it("should clear the session replay opt-in when consent is denied", async () => {
    setupTransaction()
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([{ key: "analyticsConsent", value: "denied" }])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    const prefs = await service.updatePreferences(WORKSPACE_ID, USER_ID, { analyticsConsent: "denied" })

    expect(bulkSet).toHaveBeenCalledWith({}, USER_ID, [{ key: "analyticsConsent", value: "denied" }])
    expect(bulkDelete).toHaveBeenCalledWith({}, USER_ID, ["sessionReplayOptIn"])
    expect(prefs.sessionReplayOptIn).toBe(false)
  })

  it("should clear the session replay opt-in when consent is reset to unset", async () => {
    setupTransaction()
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    await service.updatePreferences(WORKSPACE_ID, USER_ID, { analyticsConsent: "unset" })

    expect(bulkDelete).toHaveBeenCalledWith({}, USER_ID, ["analyticsConsent", "sessionReplayOptIn"])
  })

  it("should refuse a replay opt-in sent alongside a consent withdrawal", async () => {
    setupTransaction()
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([{ key: "analyticsConsent", value: "denied" }])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    const prefs = await service.updatePreferences(WORKSPACE_ID, USER_ID, {
      analyticsConsent: "denied",
      sessionReplayOptIn: true,
    })

    expect(bulkSet).toHaveBeenCalledWith({}, USER_ID, [{ key: "analyticsConsent", value: "denied" }])
    expect(bulkDelete).toHaveBeenCalledWith({}, USER_ID, ["sessionReplayOptIn"])
    expect(prefs.sessionReplayOptIn).toBe(false)
  })

  it("should keep the replay opt-in when consent stays granted", async () => {
    setupTransaction()
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([
      { key: "analyticsConsent", value: "granted" },
      { key: "sessionReplayOptIn", value: true },
    ])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    const prefs = await service.updatePreferences(WORKSPACE_ID, USER_ID, {
      analyticsConsent: "granted",
      sessionReplayOptIn: true,
    })

    expect(bulkSet).toHaveBeenCalledWith({}, USER_ID, [
      { key: "analyticsConsent", value: "granted" },
      { key: "sessionReplayOptIn", value: true },
    ])
    expect(bulkDelete).not.toHaveBeenCalled()
    expect(prefs.sessionReplayOptIn).toBe(true)
  })
})

describe("UserPreferencesService.updatePreferences board ledger settings", () => {
  afterEach(() => mock.restore())

  it("stores non-default ledger settings and deletes ones back at their default", async () => {
    setupTransaction()
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([
      { key: "boardFullTailCount", value: 3 },
      { key: "boardLedgerRows", value: 40 },
      { key: "boardLeadLineLength", value: 200 },
      { key: "boardMassBadge", value: "off" },
    ])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    const prefs = await service.updatePreferences(WORKSPACE_ID, USER_ID, {
      boardFullTailCount: 3,
      boardLedgerRows: 40,
      boardLeadLineLength: 200,
      boardMassBadge: "off",
    })

    expect(bulkSet).toHaveBeenCalledWith({}, USER_ID, [
      { key: "boardFullTailCount", value: 3 },
      { key: "boardLedgerRows", value: 40 },
      { key: "boardLeadLineLength", value: 200 },
      { key: "boardMassBadge", value: "off" },
    ])
    expect(bulkDelete).not.toHaveBeenCalled()
    expect({
      boardFullTailCount: prefs.boardFullTailCount,
      boardLedgerRows: prefs.boardLedgerRows,
      boardLeadLineLength: prefs.boardLeadLineLength,
      boardMassBadge: prefs.boardMassBadge,
    }).toEqual({
      boardFullTailCount: 3,
      boardLedgerRows: 40,
      boardLeadLineLength: 200,
      boardMassBadge: "off",
    })
  })

  it("drops the override when a ledger setting returns to its default", async () => {
    setupTransaction()
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    const prefs = await service.updatePreferences(WORKSPACE_ID, USER_ID, {
      boardLedgerRows: DEFAULT_BOARD_LEDGER_ROWS,
    })

    expect(bulkDelete).toHaveBeenCalledWith({}, USER_ID, ["boardLedgerRows"])
    expect(bulkSet).not.toHaveBeenCalled()
    expect(prefs.boardLedgerRows).toBe(DEFAULT_BOARD_LEDGER_ROWS)
  })
})

describe("UserPreferencesService.updatePreferences codeBlockWrapOverrides", () => {
  afterEach(() => mock.restore())

  it("stores the whole override map and clears it again when it returns to empty", async () => {
    setupTransaction()
    const bulkSet = spyOn(UserPreferencesRepository, "bulkSetOverrides").mockResolvedValue(undefined as any)
    const bulkDelete = spyOn(UserPreferencesRepository, "bulkDeleteOverrides").mockResolvedValue(undefined as any)
    spyOn(UserPreferencesRepository, "findOverrides").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new UserPreferencesService({} as any)

    await service.updatePreferences(WORKSPACE_ID, USER_ID, { codeBlockWrapOverrides: { sql: "wrap" } })
    expect(bulkSet).toHaveBeenCalledWith({}, USER_ID, [{ key: "codeBlockWrapOverrides", value: { sql: "wrap" } }])

    await service.updatePreferences(WORKSPACE_ID, USER_ID, { codeBlockWrapOverrides: {} })
    expect(bulkDelete).toHaveBeenCalledWith({}, USER_ID, ["codeBlockWrapOverrides"])
  })
})
