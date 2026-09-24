import { beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { createModelRegistry } from "@threahq/agent-runtime"
import { WorkspaceSettingsService } from "../../src/features/workspace-settings"
import { workspaceId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"

describe("sandboxInternet workspace setting", () => {
  let service: WorkspaceSettingsService

  beforeAll(async () => {
    const pool: Pool = await setupTestDatabase()
    service = new WorkspaceSettingsService(pool, createModelRegistry())
  })

  test("an admin's choice is stored and read back, and turning it on again returns to the default", async () => {
    const ws = workspaceId()

    const before = (await service.getSettings(ws)).sandboxInternet
    await service.updateSettings(ws, { sandboxInternet: false })
    const off = (await service.getSettings(ws)).sandboxInternet
    await service.updateSettings(ws, { sandboxInternet: true })
    const on = (await service.getSettings(ws)).sandboxInternet

    expect({ before, off, on }).toEqual({ before: true, off: false, on: true })
  })
})
