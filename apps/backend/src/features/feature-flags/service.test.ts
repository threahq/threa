import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { FEATURE_FLAG_KEYS, defaultFeatureFlags } from "@threa/types"
import { FeatureFlagService } from "./service"
import { FeatureFlagOverrideRepository } from "./repository"
import { UserRepository } from "../workspaces"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const USER_ID = "user_1"
const WORKOS_USER_ID = "workos_user_1"

function setupTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

describe("FeatureFlagService.getFlags", () => {
  afterEach(() => mock.restore())

  it("defaults every registry flag when nothing is stored", async () => {
    spyOn(FeatureFlagOverrideRepository, "findLayers").mockResolvedValue({ workspace: {}, user: {} })
    const service = new FeatureFlagService({} as any)

    const flags = await service.getFlags(WORKSPACE_ID, WORKOS_USER_ID)

    expect(flags).toEqual(defaultFeatureFlags())
  })

  it("ignores stored overrides whose key is no longer in the registry", async () => {
    spyOn(FeatureFlagOverrideRepository, "findLayers").mockResolvedValue({
      workspace: { "retired-workspace-flag": "on" },
      user: { "retired-user-flag": "off" },
    })
    const service = new FeatureFlagService({} as any)

    const flags = await service.getFlags(WORKSPACE_ID, WORKOS_USER_ID)

    expect(flags).toEqual(defaultFeatureFlags())
    expect(Object.keys(flags)).toEqual([...FEATURE_FLAG_KEYS])
  })
})

describe("FeatureFlagService.applySync", () => {
  afterEach(() => mock.restore())

  it("writes the user layer and broadcasts the raw user overrides in one transaction", async () => {
    setupTransaction()
    spyOn(UserRepository, "findByWorkosUserIdInWorkspace").mockResolvedValue({ id: USER_ID } as any)
    const replace = spyOn(FeatureFlagOverrideRepository, "replaceForSubject").mockResolvedValue()
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new FeatureFlagService({} as any)

    await service.applySync({
      workspaceId: WORKSPACE_ID,
      subjectType: "user",
      subjectId: WORKOS_USER_ID,
      overrides: { newComposer: "on" },
    })

    // Storage keys on the workos id (decision 2), not the regional user id.
    expect(replace).toHaveBeenCalledWith({}, WORKSPACE_ID, "user", WORKOS_USER_ID, { newComposer: "on" })
    // User-scoped broadcast carrying the raw user layer, routed to the regional user.
    expect(insert).toHaveBeenCalledWith({}, "feature_flags:updated", {
      workspaceId: WORKSPACE_ID,
      targetUserId: USER_ID,
      overrides: { newComposer: "on" },
    })
  })

  it("still writes the user layer when the WorkOS user has no regional row yet, skipping only the broadcast", async () => {
    setupTransaction()
    spyOn(UserRepository, "findByWorkosUserIdInWorkspace").mockResolvedValue(null)
    const replace = spyOn(FeatureFlagOverrideRepository, "replaceForSubject").mockResolvedValue()
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new FeatureFlagService({} as any)

    await service.applySync({
      workspaceId: WORKSPACE_ID,
      subjectType: "user",
      subjectId: WORKOS_USER_ID,
      overrides: { newComposer: "on" },
    })

    // The write lands regardless — the decision-2 fix (the old code dropped it).
    expect(replace).toHaveBeenCalledWith({}, WORKSPACE_ID, "user", WORKOS_USER_ID, { newComposer: "on" })
    expect(insert).not.toHaveBeenCalled()
  })

  it("writes the workspace layer and emits the workspace-scoped event, resolving no user", async () => {
    setupTransaction()
    const findUser = spyOn(UserRepository, "findByWorkosUserIdInWorkspace")
    const replace = spyOn(FeatureFlagOverrideRepository, "replaceForSubject").mockResolvedValue()
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new FeatureFlagService({} as any)

    await service.applySync({
      workspaceId: WORKSPACE_ID,
      subjectType: "workspace",
      subjectId: WORKSPACE_ID,
      overrides: { calls: "off" },
    })

    expect(replace).toHaveBeenCalledWith({}, WORKSPACE_ID, "workspace", WORKSPACE_ID, { calls: "off" })
    expect(insert).toHaveBeenCalledWith({}, "feature_flags:workspace_updated", {
      workspaceId: WORKSPACE_ID,
      overrides: { calls: "off" },
    })
    // Workspace scope routes to the workspace room; no regional-user lookup happens.
    expect(findUser).not.toHaveBeenCalled()
  })
})
