import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { HttpError } from "@threa/backend-common"
import { defaultFeatureFlags } from "@threa/types"
import { ControlPlaneFeatureFlagService } from "./service"
import { FeatureFlagOverrideRepository } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import type { RegionalClient } from "../../lib/regional-client"

const WORKSPACE_ID = "ws_1"
const WORKOS_USER_ID = "workos_user_1"

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
})

describe("ControlPlaneFeatureFlagService.syncToRegion", () => {
  afterEach(() => mock.restore())

  it("pushes the user's resolved snapshot to the workspace's region, dropping retired overrides", async () => {
    spyOn(WorkspaceRegistryRepository, "findById").mockResolvedValue({ id: WORKSPACE_ID, region: "eu" } as any)
    // A stored override whose key is no longer in the registry resolves away,
    // so the snapshot pushed to the region is the bare defaults.
    spyOn(FeatureFlagOverrideRepository, "listForUser").mockResolvedValue([
      { workosUserId: WORKOS_USER_ID, flagKey: "retired-flag", value: "on", updatedAt: new Date() },
    ])
    const sync = mock(() => Promise.resolve())
    const service = makeService({ syncUserFeatureFlags: sync } as any)

    await service.syncToRegion({ workspaceId: WORKSPACE_ID, workosUserId: WORKOS_USER_ID })

    expect(sync).toHaveBeenCalledWith("eu", {
      workspaceId: WORKSPACE_ID,
      workosUserId: WORKOS_USER_ID,
      flags: defaultFeatureFlags(),
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
