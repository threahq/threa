import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as backendCommon from "@threahq/backend-common"
import { HttpError, OutboxRepository } from "@threahq/backend-common"
import { FEATURE_FLAG_DEFINITIONS, type FeatureFlagDefinition } from "@threahq/types"
import { ControlPlaneFeatureFlagService, OUTBOX_FEATURE_FLAGS_SYNC } from "./service"
import { FeatureFlagOverrideRepository } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import type { RegionalClient } from "../../lib/regional-client"

const WORKSPACE_ID = "ws_1"
const WORKOS_USER_ID = "workos_user_1"

// The shipped FEATURE_FLAGS is empty between rollouts, so inject a stand-in
// registry (visible to the code-bound predicates, which read
// FEATURE_FLAG_DEFINITIONS dynamically) and clear it after each test rather
// than committing a fake flag to @threahq/types.
const STANDIN_REGISTRY = {
  wsOnly: { values: ["off", "on"], scopes: ["workspace"], default: "off" },
  userOnly: { values: ["off", "on"], scopes: ["user"], default: "off" },
  both: { values: ["off", "shadow", "active"], scopes: ["workspace", "user"], default: "off" },
} as const satisfies Record<string, FeatureFlagDefinition>

function injectRegistry() {
  Object.assign(FEATURE_FLAG_DEFINITIONS, STANDIN_REGISTRY)
}

function resetRegistry() {
  for (const key of Object.keys(STANDIN_REGISTRY)) delete FEATURE_FLAG_DEFINITIONS[key]
}

function makeService(regionalClient: Partial<RegionalClient> = {}) {
  return new ControlPlaneFeatureFlagService({ pool: {} as any, regionalClient: regionalClient as RegionalClient })
}

function stubWrite(): {
  setOverride: ReturnType<typeof spyOn>
  deleteOverride: ReturnType<typeof spyOn>
  insert: ReturnType<typeof spyOn>
} {
  spyOn(WorkspaceRegistryRepository, "findById").mockResolvedValue({ id: WORKSPACE_ID, region: "eu" } as any)
  spyOn(backendCommon, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: unknown) => unknown) =>
    fn({})) as typeof backendCommon.withTransaction)
  return {
    setOverride: spyOn(FeatureFlagOverrideRepository, "setOverride").mockResolvedValue(),
    deleteOverride: spyOn(FeatureFlagOverrideRepository, "deleteOverride").mockResolvedValue(),
    insert: spyOn(OutboxRepository, "insert").mockResolvedValue({} as any),
  }
}

async function expectHttpError(promise: Promise<unknown>, code: string, status = 400): Promise<void> {
  try {
    await promise
    throw new Error(`expected HttpError ${code}`)
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError)
    expect({ code: (err as HttpError).code, status: (err as HttpError).status }).toEqual({ code, status })
  }
}

describe("ControlPlaneFeatureFlagService.setFlag", () => {
  afterEach(() => {
    resetRegistry()
    mock.restore()
  })

  it("rejects keys that are not in the registry", async () => {
    await expectHttpError(
      makeService().setFlag({
        workspaceId: WORKSPACE_ID,
        subjectType: "user",
        subjectId: WORKOS_USER_ID,
        flagKey: "nope",
        value: "on",
      }),
      "UNKNOWN_FLAG"
    )
  })

  it("writes a subject_type='workspace' row keyed by the workspace id for a workspace-scope set", async () => {
    injectRegistry()
    const { setOverride, insert } = stubWrite()

    await makeService().setFlag({
      workspaceId: WORKSPACE_ID,
      subjectType: "workspace",
      subjectId: WORKSPACE_ID,
      flagKey: "wsOnly",
      value: "on",
    })

    expect(setOverride).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, subjectType: "workspace", subjectId: WORKSPACE_ID, flagKey: "wsOnly", value: "on" }
    )
    expect(insert).toHaveBeenCalledWith({}, OUTBOX_FEATURE_FLAGS_SYNC, {
      workspaceId: WORKSPACE_ID,
      subjectType: "workspace",
      subjectId: WORKSPACE_ID,
    })
  })

  it("writes a subject_type='user' row for a user-scope set", async () => {
    injectRegistry()
    const { setOverride, insert } = stubWrite()

    await makeService().setFlag({
      workspaceId: WORKSPACE_ID,
      subjectType: "user",
      subjectId: WORKOS_USER_ID,
      flagKey: "userOnly",
      value: "on",
    })

    expect(setOverride).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, subjectType: "user", subjectId: WORKOS_USER_ID, flagKey: "userOnly", value: "on" }
    )
    expect(insert).toHaveBeenCalledWith({}, OUTBOX_FEATURE_FLAGS_SYNC, {
      workspaceId: WORKSPACE_ID,
      subjectType: "user",
      subjectId: WORKOS_USER_ID,
    })
  })

  it("rejects a user-scope write to a workspace-only flag", async () => {
    injectRegistry()
    await expectHttpError(
      makeService().setFlag({
        workspaceId: WORKSPACE_ID,
        subjectType: "user",
        subjectId: WORKOS_USER_ID,
        flagKey: "wsOnly",
        value: "on",
      }),
      "FLAG_SCOPE_NOT_ALLOWED"
    )
  })

  it("rejects a workspace-scope write whose subjectId is not the workspace id", async () => {
    injectRegistry()
    await expectHttpError(
      makeService().setFlag({
        workspaceId: WORKSPACE_ID,
        subjectType: "workspace",
        subjectId: WORKOS_USER_ID,
        flagKey: "wsOnly",
        value: "on",
      }),
      "INVALID_SUBJECT"
    )
  })

  it("rejects a workspace-scope write to a user-only flag", async () => {
    injectRegistry()
    await expectHttpError(
      makeService().setFlag({
        workspaceId: WORKSPACE_ID,
        subjectType: "workspace",
        subjectId: WORKSPACE_ID,
        flagKey: "userOnly",
        value: "on",
      }),
      "FLAG_SCOPE_NOT_ALLOWED"
    )
  })

  it("clears the override (delete, no write) when set to the default value at either scope", async () => {
    injectRegistry()
    const { setOverride, deleteOverride } = stubWrite()

    await makeService().setFlag({
      workspaceId: WORKSPACE_ID,
      subjectType: "workspace",
      subjectId: WORKSPACE_ID,
      flagKey: "wsOnly",
      value: "off",
    })
    await makeService().setFlag({
      workspaceId: WORKSPACE_ID,
      subjectType: "user",
      subjectId: WORKOS_USER_ID,
      flagKey: "userOnly",
      value: "off",
    })

    expect(setOverride).not.toHaveBeenCalled()
    expect(deleteOverride).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, subjectType: "workspace", subjectId: WORKSPACE_ID, flagKey: "wsOnly" }
    )
    expect(deleteOverride).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, subjectType: "user", subjectId: WORKOS_USER_ID, flagKey: "userOnly" }
    )
  })
})

describe("ControlPlaneFeatureFlagService.syncToRegion", () => {
  afterEach(() => {
    resetRegistry()
    mock.restore()
  })

  it("pushes the subject's raw overrides filtered by registry and scope, not a resolved map", async () => {
    injectRegistry()
    spyOn(WorkspaceRegistryRepository, "findById").mockResolvedValue({ id: WORKSPACE_ID, region: "eu" } as any)
    spyOn(FeatureFlagOverrideRepository, "listForSubject").mockResolvedValue([
      { subjectType: "workspace", subjectId: WORKSPACE_ID, flagKey: "wsOnly", value: "on", updatedAt: new Date() },
      // userOnly is user-scoped, so a workspace row for it is inert.
      { subjectType: "workspace", subjectId: WORKSPACE_ID, flagKey: "userOnly", value: "on", updatedAt: new Date() },
      // retired key: no longer in the registry.
      { subjectType: "workspace", subjectId: WORKSPACE_ID, flagKey: "retired", value: "on", updatedAt: new Date() },
    ])
    const sync = mock(() => Promise.resolve())
    const service = makeService({ syncFeatureFlags: sync } as any)

    await service.syncToRegion({ workspaceId: WORKSPACE_ID, subjectType: "workspace", subjectId: WORKSPACE_ID })

    expect(sync).toHaveBeenCalledWith("eu", {
      workspaceId: WORKSPACE_ID,
      subjectType: "workspace",
      subjectId: WORKSPACE_ID,
      overrides: { wsOnly: "on" },
    })
  })

  it("skips quietly when the workspace is gone from the registry", async () => {
    spyOn(WorkspaceRegistryRepository, "findById").mockResolvedValue(null)
    const sync = mock(() => Promise.resolve())
    const service = makeService({ syncFeatureFlags: sync } as any)

    await service.syncToRegion({ workspaceId: WORKSPACE_ID, subjectType: "user", subjectId: WORKOS_USER_ID })

    expect(sync).not.toHaveBeenCalled()
  })
})
