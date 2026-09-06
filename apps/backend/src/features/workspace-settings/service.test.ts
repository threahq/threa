import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { DEFAULT_WORK_SCHEDULE, DEFAULT_MAX_PENDING_FOLLOW_UPS, type WorkSchedule } from "@threahq/types"
import { WorkspaceSettingsService } from "./service"
import { WorkspaceSettingsRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { PersonaRepository } from "../agents"
import * as dbModule from "../../db"
import type { ModelRegistry } from "@threahq/agent-runtime"

const WORKSPACE_ID = "ws_1"

/** The registry the delegable-model check consults; every id in these tests is a chat model. */
const modelRegistry = { isChatModel: () => true } as unknown as ModelRegistry

const CUSTOM_SCHEDULE: WorkSchedule = {
  days: {
    0: [{ start: "09:00", end: "13:00" }],
    1: [{ start: "08:00", end: "16:00" }],
    2: [{ start: "08:00", end: "16:00" }],
    3: [{ start: "08:00", end: "16:00" }],
    4: [{ start: "08:00", end: "16:00" }],
    5: [],
    6: [],
  },
}

function setupTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

describe("WorkspaceSettingsService.getSettings", () => {
  afterEach(() => mock.restore())

  it("falls back to defaults when no overrides are stored", async () => {
    spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([])
    const service = new WorkspaceSettingsService({} as any, modelRegistry)

    const settings = await service.getSettings(WORKSPACE_ID)

    expect(settings.workspaceId).toBe(WORKSPACE_ID)
    expect(settings.defaultWorkSchedule).toEqual(DEFAULT_WORK_SCHEDULE)
  })

  it("merges a stored override onto defaults", async () => {
    spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([
      { key: "defaultWorkSchedule", value: CUSTOM_SCHEDULE },
    ])
    const service = new WorkspaceSettingsService({} as any, modelRegistry)

    const settings = await service.getSettings(WORKSPACE_ID)

    expect(settings.defaultWorkSchedule).toEqual(CUSTOM_SCHEDULE)
  })
})

describe("WorkspaceSettingsService.updateSettings", () => {
  afterEach(() => mock.restore())

  it("stores a non-default schedule as an override and broadcasts it", async () => {
    setupTransaction()
    const setOverride = spyOn(WorkspaceSettingsRepository, "setOverride").mockResolvedValue()
    const deleteOverride = spyOn(WorkspaceSettingsRepository, "deleteOverride").mockResolvedValue()
    spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([
      { key: "defaultWorkSchedule", value: CUSTOM_SCHEDULE },
    ])
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new WorkspaceSettingsService({} as any, modelRegistry)

    const settings = await service.updateSettings(WORKSPACE_ID, { defaultWorkSchedule: CUSTOM_SCHEDULE })

    expect(setOverride).toHaveBeenCalledWith({}, WORKSPACE_ID, "defaultWorkSchedule", CUSTOM_SCHEDULE)
    expect(deleteOverride).not.toHaveBeenCalled()
    expect(settings.defaultWorkSchedule).toEqual(CUSTOM_SCHEDULE)
    // Workspace-scoped broadcast so every member's bootstrap cache converges.
    expect(insert).toHaveBeenCalledWith({}, "workspace_settings:updated", { workspaceId: WORKSPACE_ID, settings })
  })

  it("clears the override when set back to the default", async () => {
    setupTransaction()
    const setOverride = spyOn(WorkspaceSettingsRepository, "setOverride").mockResolvedValue()
    const deleteOverride = spyOn(WorkspaceSettingsRepository, "deleteOverride").mockResolvedValue()
    spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new WorkspaceSettingsService({} as any, modelRegistry)

    await service.updateSettings(WORKSPACE_ID, { defaultWorkSchedule: DEFAULT_WORK_SCHEDULE })

    expect(deleteOverride).toHaveBeenCalledWith({}, WORKSPACE_ID, "defaultWorkSchedule")
    expect(setOverride).not.toHaveBeenCalled()
  })

  it("stores a raised follow-up cap as an override (roadmap 1.4)", async () => {
    setupTransaction()
    const setOverride = spyOn(WorkspaceSettingsRepository, "setOverride").mockResolvedValue()
    const deleteOverride = spyOn(WorkspaceSettingsRepository, "deleteOverride").mockResolvedValue()
    spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([{ key: "maxPendingFollowUps", value: 25 }])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new WorkspaceSettingsService({} as any, modelRegistry)

    const settings = await service.updateSettings(WORKSPACE_ID, { maxPendingFollowUps: 25 })

    expect(setOverride).toHaveBeenCalledWith({}, WORKSPACE_ID, "maxPendingFollowUps", 25)
    expect(deleteOverride).not.toHaveBeenCalled()
    expect(settings.maxPendingFollowUps).toBe(25)
  })

  it("clears the follow-up cap override when reset to the default (roadmap 1.4)", async () => {
    setupTransaction()
    const setOverride = spyOn(WorkspaceSettingsRepository, "setOverride").mockResolvedValue()
    const deleteOverride = spyOn(WorkspaceSettingsRepository, "deleteOverride").mockResolvedValue()
    spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new WorkspaceSettingsService({} as any, modelRegistry)

    await service.updateSettings(WORKSPACE_ID, { maxPendingFollowUps: DEFAULT_MAX_PENDING_FOLLOW_UPS })

    expect(deleteOverride).toHaveBeenCalledWith({}, WORKSPACE_ID, "maxPendingFollowUps")
    expect(setOverride).not.toHaveBeenCalled()
  })
})

describe("WorkspaceSettingsService.updateSettings defaultCompanionPersonaId", () => {
  afterEach(() => mock.restore())

  it("stores an active persona id as an override", async () => {
    setupTransaction()
    const findById = spyOn(PersonaRepository, "findById").mockResolvedValue({ status: "active" } as any)
    const setOverride = spyOn(WorkspaceSettingsRepository, "setOverride").mockResolvedValue()
    spyOn(WorkspaceSettingsRepository, "deleteOverride").mockResolvedValue()
    spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([
      { key: "defaultCompanionPersonaId", value: "persona_x" },
    ])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new WorkspaceSettingsService({} as any, modelRegistry)

    const settings = await service.updateSettings(WORKSPACE_ID, { defaultCompanionPersonaId: "persona_x" })

    expect(findById).toHaveBeenCalledWith({}, "persona_x", WORKSPACE_ID)
    expect(setOverride).toHaveBeenCalledWith({}, WORKSPACE_ID, "defaultCompanionPersonaId", "persona_x")
    expect(settings.defaultCompanionPersonaId).toBe("persona_x")
  })

  it("rejects an archived persona id with a 400", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue({ status: "archived" } as any)
    const setOverride = spyOn(WorkspaceSettingsRepository, "setOverride").mockResolvedValue()
    const service = new WorkspaceSettingsService({} as any, modelRegistry)

    await expect(
      service.updateSettings(WORKSPACE_ID, { defaultCompanionPersonaId: "persona_x" })
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_AVAILABLE" })
    expect(setOverride).not.toHaveBeenCalled()
  })

  it("rejects an id not resolvable in this workspace with a 400", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue(null)
    const setOverride = spyOn(WorkspaceSettingsRepository, "setOverride").mockResolvedValue()
    const service = new WorkspaceSettingsService({} as any, modelRegistry)

    await expect(
      service.updateSettings(WORKSPACE_ID, { defaultCompanionPersonaId: "persona_other_ws" })
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_AVAILABLE" })
    expect(setOverride).not.toHaveBeenCalled()
  })

  it("clears the override on null without a persona lookup", async () => {
    setupTransaction()
    const findById = spyOn(PersonaRepository, "findById").mockResolvedValue({ status: "active" } as any)
    const setOverride = spyOn(WorkspaceSettingsRepository, "setOverride").mockResolvedValue()
    const deleteOverride = spyOn(WorkspaceSettingsRepository, "deleteOverride").mockResolvedValue()
    spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new WorkspaceSettingsService({} as any, modelRegistry)

    await service.updateSettings(WORKSPACE_ID, { defaultCompanionPersonaId: null })

    expect(findById).not.toHaveBeenCalled()
    expect(deleteOverride).toHaveBeenCalledWith({}, WORKSPACE_ID, "defaultCompanionPersonaId")
    expect(setOverride).not.toHaveBeenCalled()
  })
})
