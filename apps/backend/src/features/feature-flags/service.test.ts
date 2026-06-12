import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS, defaultFeatureFlags } from "@threa/types"
import { FeatureFlagService } from "./service"
import { UserFeatureFlagRepository } from "./repository"
import { UserRepository } from "../workspaces"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const USER_ID = "user_1"
const WORKOS_USER_ID = "workos_user_1"
const FLAG = FEATURE_FLAG_KEYS[0]
// Every flag has at least one non-default value; use the first one.
const NON_DEFAULT_VALUE = FEATURE_FLAGS[FLAG][1]

function setupTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

describe("FeatureFlagService.getFlags", () => {
  afterEach(() => mock.restore())

  it("defaults every registry flag to its first declared value when nothing is stored", async () => {
    spyOn(UserFeatureFlagRepository, "findForUser").mockResolvedValue([])
    const service = new FeatureFlagService({} as any)

    const flags = await service.getFlags(WORKSPACE_ID, USER_ID)

    expect(flags).toEqual(defaultFeatureFlags())
  })

  it("applies stored rows and ignores retired keys and undeclared values", async () => {
    spyOn(UserFeatureFlagRepository, "findForUser").mockResolvedValue([
      { flagKey: FLAG, value: NON_DEFAULT_VALUE },
      { flagKey: "retired-flag-not-in-registry", value: "on" },
      { flagKey: FLAG, value: "value-never-declared-for-this-flag" },
    ])
    const service = new FeatureFlagService({} as any)

    const flags = await service.getFlags(WORKSPACE_ID, USER_ID)

    expect(flags[FLAG]).toBe(NON_DEFAULT_VALUE)
    expect(Object.keys(flags).sort()).toEqual([...FEATURE_FLAG_KEYS].sort())
  })
})

describe("FeatureFlagService.getFlag", () => {
  afterEach(() => mock.restore())

  it("returns the stored value for a registry key", async () => {
    spyOn(UserFeatureFlagRepository, "findForUser").mockResolvedValue([{ flagKey: FLAG, value: NON_DEFAULT_VALUE }])
    const service = new FeatureFlagService({} as any)

    expect(await service.getFlag(WORKSPACE_ID, USER_ID, FLAG)).toBe(NON_DEFAULT_VALUE)
  })
})

describe("FeatureFlagService.applySync", () => {
  afterEach(() => mock.restore())

  it("replaces the user's rows and broadcasts the resolved snapshot in one transaction", async () => {
    setupTransaction()
    spyOn(UserRepository, "findByWorkosUserIdInWorkspace").mockResolvedValue({ id: USER_ID } as any)
    const replace = spyOn(UserFeatureFlagRepository, "replaceForUser").mockResolvedValue()
    spyOn(UserFeatureFlagRepository, "findForUser").mockResolvedValue([{ flagKey: FLAG, value: NON_DEFAULT_VALUE }])
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new FeatureFlagService({} as any)

    const applied = await service.applySync({
      workspaceId: WORKSPACE_ID,
      workosUserId: WORKOS_USER_ID,
      flags: { [FLAG]: NON_DEFAULT_VALUE },
    })

    expect(applied).toBe(true)
    expect(replace).toHaveBeenCalledWith({}, WORKSPACE_ID, USER_ID, { [FLAG]: NON_DEFAULT_VALUE })
    // User-scoped broadcast carrying the full resolved map (INV-7: same transaction).
    expect(insert).toHaveBeenCalledWith({}, "feature_flags:updated", {
      workspaceId: WORKSPACE_ID,
      targetUserId: USER_ID,
      featureFlags: expect.objectContaining({ [FLAG]: NON_DEFAULT_VALUE }),
    })
  })

  it("skips without writing when the WorkOS user has no regional row yet", async () => {
    spyOn(UserRepository, "findByWorkosUserIdInWorkspace").mockResolvedValue(null)
    const replace = spyOn(UserFeatureFlagRepository, "replaceForUser").mockResolvedValue()
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new FeatureFlagService({} as any)

    const applied = await service.applySync({
      workspaceId: WORKSPACE_ID,
      workosUserId: WORKOS_USER_ID,
      flags: { [FLAG]: NON_DEFAULT_VALUE },
    })

    expect(applied).toBe(false)
    expect(replace).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })
})
