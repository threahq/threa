import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { ALL_SIDEBAR_CONFIG, DEFAULT_SIDEBAR_CONFIG, DEFAULT_QUICK_LINKS, type SidebarConfig } from "@threa/types"
import { SidebarConfigService } from "./service"
import { SidebarConfigRepository } from "./repository"
import { updateSidebarConfigSchema } from "./handlers"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const USER_ID = "usr_1"

function setupService() {
  // withTransaction invokes the callback with a fake client.
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  return new SidebarConfigService({} as any)
}

describe("SidebarConfigService.getConfig", () => {
  afterEach(() => mock.restore())

  it("returns the stored config when the user has customized it", async () => {
    const service = setupService()
    spyOn(SidebarConfigRepository, "find").mockResolvedValue(ALL_SIDEBAR_CONFIG)

    const config = await service.getConfig(WORKSPACE_ID, USER_ID)

    expect(config).toEqual(ALL_SIDEBAR_CONFIG)
  })

  it("falls back to the default config when none is stored", async () => {
    const service = setupService()
    spyOn(SidebarConfigRepository, "find").mockResolvedValue(null)

    const config = await service.getConfig(WORKSPACE_ID, USER_ID)

    expect(config).toEqual(DEFAULT_SIDEBAR_CONFIG)
  })

  it("normalizes a stored config that pre-dates quick links", async () => {
    const service = setupService()
    // A row persisted before quick links were configurable has no quickLinks key.
    spyOn(SidebarConfigRepository, "find").mockResolvedValue({
      basePreset: "smart",
      sections: [],
    } as unknown as SidebarConfig)

    const config = await service.getConfig(WORKSPACE_ID, USER_ID)

    expect(config.quickLinks).toEqual(DEFAULT_QUICK_LINKS)
  })
})

describe("SidebarConfigService.updateConfig", () => {
  afterEach(() => mock.restore())

  it("persists the config and emits an author-scoped sidebar_config:updated event", async () => {
    const service = setupService()

    const upsert = spyOn(SidebarConfigRepository, "upsert").mockResolvedValue(undefined)
    const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const next: SidebarConfig = {
      basePreset: "all",
      sections: [{ id: "channels", spec: { kind: "type", streamType: "channel" } }],
      quickLinks: DEFAULT_QUICK_LINKS,
    }
    const result = await service.updateConfig(WORKSPACE_ID, USER_ID, next)

    expect(result).toEqual(next)
    expect(upsert).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, USER_ID, next)
    expect(outboxInsert).toHaveBeenCalledWith(expect.anything(), "sidebar_config:updated", {
      workspaceId: WORKSPACE_ID,
      authorId: USER_ID,
      sidebarConfig: next,
    })
  })

  it("normalizes a config with an incomplete quick-link list before persisting", async () => {
    const service = setupService()
    const upsert = spyOn(SidebarConfigRepository, "upsert").mockResolvedValue(undefined)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const partial: SidebarConfig = { basePreset: "smart", sections: [], quickLinks: [] }
    const result = await service.updateConfig(WORKSPACE_ID, USER_ID, partial)

    expect(result.quickLinks).toEqual(DEFAULT_QUICK_LINKS)
    expect(upsert).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      USER_ID,
      expect.objectContaining({ quickLinks: DEFAULT_QUICK_LINKS })
    )
  })
})

describe("updateSidebarConfigSchema", () => {
  it("accepts a body without quickLinks (old client) and defaults it to an empty list", () => {
    // The service then normalizes the empty list to the full default set.
    const parsed = updateSidebarConfigSchema.parse({ basePreset: "smart", sections: [] })
    expect(parsed.quickLinks).toEqual([])
  })
})
