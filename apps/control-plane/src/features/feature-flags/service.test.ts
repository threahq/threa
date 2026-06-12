import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { HttpError, OutboxRepository } from "@threa/backend-common"
import * as backendCommon from "@threa/backend-common"
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS, defaultFeatureFlags } from "@threa/types"
import { ControlPlaneFeatureFlagService, OUTBOX_FEATURE_FLAGS_SYNC } from "./service"
import { FeatureFlagOverrideRepository } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import type { RegionalClient } from "../../lib/regional-client"

const WORKSPACE_ID = "ws_1"
const WORKOS_USER_ID = "workos_user_1"
const FLAG = FEATURE_FLAG_KEYS[0]
const DEFAULT_VALUE = FEATURE_FLAGS[FLAG][0]
const NON_DEFAULT_VALUE = FEATURE_FLAGS[FLAG][1]

function setupTransaction() {
  spyOn(backendCommon, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

function makeService(regionalClient: Partial<RegionalClient> = {}) {
  return new ControlPlaneFeatureFlagService({ pool: {} as any, regionalClient: regionalClient as RegionalClient })
}

describe("ControlPlaneFeatureFlagService.setFlag", () => {
  afterEach(() => mock.restore())

  it("rejects keys that are not in the registry", async () => {
    const service = makeService()

    await expect(
      service.setFlag({ workspaceId: WORKSPACE_ID, workosUserId: WORKOS_USER_ID, flagKey: "nope", value: "on" })
    ).rejects.toThrow(HttpError)
  })

  it("rejects values that are not declared for the flag", async () => {
    const service = makeService()

    await expect(
      service.setFlag({ workspaceId: WORKSPACE_ID, workosUserId: WORKOS_USER_ID, flagKey: FLAG, value: "nope" })
    ).rejects.toThrow(HttpError)
  })

  it("upserts the override and emits the sync outbox event atomically", async () => {
    setupTransaction()
    spyOn(WorkspaceRegistryRepository, "findById").mockResolvedValue({ id: WORKSPACE_ID, region: "eu" } as any)
    const set = spyOn(FeatureFlagOverrideRepository, "setOverride").mockResolvedValue()
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = makeService()

    await service.setFlag({
      workspaceId: WORKSPACE_ID,
      workosUserId: WORKOS_USER_ID,
      flagKey: FLAG,
      value: NON_DEFAULT_VALUE,
    })

    expect(set).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, workosUserId: WORKOS_USER_ID, flagKey: FLAG, value: NON_DEFAULT_VALUE }
    )
    expect(insert).toHaveBeenCalledWith({}, OUTBOX_FEATURE_FLAGS_SYNC, {
      workspaceId: WORKSPACE_ID,
      workosUserId: WORKOS_USER_ID,
    })
  })

  it("clears the override when set to the default value", async () => {
    setupTransaction()
    spyOn(WorkspaceRegistryRepository, "findById").mockResolvedValue({ id: WORKSPACE_ID, region: "eu" } as any)
    const del = spyOn(FeatureFlagOverrideRepository, "deleteOverride").mockResolvedValue()
    const set = spyOn(FeatureFlagOverrideRepository, "setOverride").mockResolvedValue()
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = makeService()

    await service.setFlag({
      workspaceId: WORKSPACE_ID,
      workosUserId: WORKOS_USER_ID,
      flagKey: FLAG,
      value: DEFAULT_VALUE,
    })

    expect(del).toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })
})

describe("ControlPlaneFeatureFlagService.syncToRegion", () => {
  afterEach(() => mock.restore())

  it("pushes the user's resolved snapshot to the workspace's region", async () => {
    spyOn(WorkspaceRegistryRepository, "findById").mockResolvedValue({ id: WORKSPACE_ID, region: "eu" } as any)
    spyOn(FeatureFlagOverrideRepository, "listForUser").mockResolvedValue([
      { workosUserId: WORKOS_USER_ID, flagKey: FLAG, value: NON_DEFAULT_VALUE, updatedAt: new Date() },
    ])
    const sync = mock(() => Promise.resolve())
    const service = makeService({ syncUserFeatureFlags: sync } as any)

    await service.syncToRegion({ workspaceId: WORKSPACE_ID, workosUserId: WORKOS_USER_ID })

    expect(sync).toHaveBeenCalledWith("eu", {
      workspaceId: WORKSPACE_ID,
      workosUserId: WORKOS_USER_ID,
      flags: { ...defaultFeatureFlags(), [FLAG]: NON_DEFAULT_VALUE },
    })
  })

  it("skips quietly when the workspace is gone from the registry", async () => {
    spyOn(WorkspaceRegistryRepository, "findById").mockResolvedValue(null)
    const sync = mock(() => Promise.resolve())
    const service = makeService({ syncUserFeatureFlags: sync } as any)

    await service.syncToRegion({ workspaceId: WORKSPACE_ID, workosUserId: WORKOS_USER_ID })

    expect(sync).not.toHaveBeenCalled()
  })
})
