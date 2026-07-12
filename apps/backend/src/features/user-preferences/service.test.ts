import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
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
