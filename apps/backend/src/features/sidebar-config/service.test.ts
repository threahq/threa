import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import {
  ALL_SIDEBAR_CONFIG,
  DEFAULT_SIDEBAR_CONFIG,
  DEFAULT_QUICK_LINKS,
  SIDEBAR_CONFIG_VERSION,
  QUICK_LINKS_SECTION_ID,
  type SidebarConfig,
  type RawSidebarConfig,
} from "@threa/types"
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

  it("migrates a pre-v2 document: boolean enabled → visibility, and adds the quick-links section", async () => {
    const service = setupService()
    // A v1 row: no version, quick links carried boolean `enabled`, no quick-links section.
    spyOn(SidebarConfigRepository, "find").mockResolvedValue({
      basePreset: "smart",
      sections: [{ id: "recent", spec: { kind: "smart", bucket: "recent" } }],
      quickLinks: [
        { key: "drafts", enabled: false },
        { key: "saved", enabled: true },
      ],
    } as unknown as SidebarConfig)

    const config = await service.getConfig(WORKSPACE_ID, USER_ID)

    expect(config.version).toBe(SIDEBAR_CONFIG_VERSION)
    expect(config.sections[0]).toEqual({ id: QUICK_LINKS_SECTION_ID, spec: { kind: "quicklinks" } })
    expect(config.quickLinks.find((l) => l.key === "drafts")?.visibility).toBe("hidden")
    expect(config.quickLinks.find((l) => l.key === "saved")?.visibility).toBe("show")
  })
})

describe("SidebarConfigService.updateConfig", () => {
  afterEach(() => mock.restore())

  it("persists the config and emits an author-scoped sidebar_config:updated event", async () => {
    const service = setupService()

    const upsert = spyOn(SidebarConfigRepository, "upsert").mockResolvedValue(undefined)
    const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    // A canonical v2 document, so normalization is idempotent (result === next).
    const next: SidebarConfig = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "all",
      sections: [
        { id: QUICK_LINKS_SECTION_ID, spec: { kind: "quicklinks" } },
        { id: "channels", spec: { kind: "type", streamType: "channel" } },
      ],
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

    // A pre-version client body: no `version`, empty quick links. The service
    // normalizes it to the full set on write.
    const partial: RawSidebarConfig = { basePreset: "smart", sections: [], quickLinks: [] }
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

  it("accepts both the legacy boolean `enabled` and the current `visibility` link shapes", () => {
    const parsed = updateSidebarConfigSchema.parse({
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart",
      sections: [{ id: QUICK_LINKS_SECTION_ID, spec: { kind: "quicklinks" } }],
      quickLinks: [
        { key: "drafts", visibility: "active" },
        { key: "saved", enabled: false },
      ],
    })
    expect(parsed.quickLinks).toEqual([
      { key: "drafts", visibility: "active" },
      { key: "saved", enabled: false },
    ])
  })

  it("accepts the quicklinks section spec", () => {
    const parsed = updateSidebarConfigSchema.parse({
      basePreset: "smart",
      sections: [{ id: QUICK_LINKS_SECTION_ID, spec: { kind: "quicklinks" } }],
    })
    expect(parsed.sections[0].spec).toEqual({ kind: "quicklinks" })
  })

  it("accepts a custom section spec and defaults missing streamIds to an empty list", () => {
    const parsed = updateSidebarConfigSchema.parse({
      basePreset: "smart",
      sections: [
        { id: "custom:work", spec: { kind: "custom", sectionId: "work", name: "Work", streamIds: ["stream_1"] } },
        // streamIds omitted — the schema defaults it.
        { id: "custom:home", spec: { kind: "custom", sectionId: "home", name: "Home" } },
      ],
    })
    expect(parsed.sections[0].spec).toEqual({
      kind: "custom",
      sectionId: "work",
      name: "Work",
      streamIds: ["stream_1"],
    })
    expect(parsed.sections[1].spec).toMatchObject({ kind: "custom", name: "Home", streamIds: [] })
  })

  it("rejects a custom section with a blank name", () => {
    const result = updateSidebarConfigSchema.safeParse({
      basePreset: "smart",
      sections: [{ id: "custom:x", spec: { kind: "custom", sectionId: "x", name: "   ", streamIds: [] } }],
    })
    expect(result.success).toBe(false)
  })
})
