import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { DEFAULT_WORK_SCHEDULE, type WorkSchedule } from "@threa/types"
import { WorkspaceSettingsService } from "./service"
import { WorkspaceSettingsRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"

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
    const service = new WorkspaceSettingsService({} as any)

    const settings = await service.getSettings(WORKSPACE_ID)

    expect(settings.workspaceId).toBe(WORKSPACE_ID)
    expect(settings.defaultWorkSchedule).toEqual(DEFAULT_WORK_SCHEDULE)
  })

  it("merges a stored override onto defaults", async () => {
    spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([
      { key: "defaultWorkSchedule", value: CUSTOM_SCHEDULE },
    ])
    const service = new WorkspaceSettingsService({} as any)

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
    const service = new WorkspaceSettingsService({} as any)

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
    const service = new WorkspaceSettingsService({} as any)

    await service.updateSettings(WORKSPACE_ID, { defaultWorkSchedule: DEFAULT_WORK_SCHEDULE })

    expect(deleteOverride).toHaveBeenCalledWith({}, WORKSPACE_ID, "defaultWorkSchedule")
    expect(setOverride).not.toHaveBeenCalled()
  })
})
