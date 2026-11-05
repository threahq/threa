import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { StubWorkosOrgService } from "@threahq/backend-common"
import type { InvitationShadowService } from "../../src/features/invitation-shadows"
import type { PlatformAdminSyncService } from "../../src/features/platform-admin"
import {
  ControlPlaneWorkspaceService,
  createWorkspaceHandlers,
  WorkspaceRegistryRepository,
  type WorkosOrganizationProvisioner,
} from "../../src/features/workspaces"
import type { KvClient } from "../../src/lib/cloudflare-kv-client"
import type { RegionalClient } from "../../src/lib/regional-client"
import { setupTestDatabase } from "./setup"

describe("workspace name sync", () => {
  let pool: Pool
  const workspaceIds: string[] = []
  let workos: StubWorkosOrgService

  function handlers() {
    const workspaceService = new ControlPlaneWorkspaceService({
      pool,
      regionalClient: {} as RegionalClient,
      workosOrgService: workos,
      workosOrganizationProvisioner: {} as WorkosOrganizationProvisioner,
      kvClient: {} as KvClient,
      platformAdminSync: {} as PlatformAdminSyncService,
      availableRegions: ["eu"],
      requireWorkspaceCreationInvite: false,
    })
    return createWorkspaceHandlers({ workspaceService, shadowService: {} as InvitationShadowService })
  }

  async function seedWorkspaceWithOrganization(): Promise<{ workspaceId: string; organizationId: string }> {
    const workspaceId = await seedWorkspace()
    const { id: organizationId } = await workos.createOrganization({ name: "Before", externalId: workspaceId })
    await WorkspaceRegistryRepository.setWorkosOrganizationId(pool, workspaceId, organizationId)
    return { workspaceId, organizationId }
  }

  async function seedWorkspace(): Promise<string> {
    const id = `ws_name_${crypto.randomUUID().replaceAll("-", "")}`
    workspaceIds.push(id)
    await WorkspaceRegistryRepository.insert(pool, {
      id,
      name: "Before",
      slug: id.replaceAll("_", "-"),
      region: "eu",
      createdByWorkosUserId: "workos_user_1",
    })
    return id
  }

  async function sync(workspaceId: string, body: unknown): Promise<number | { status?: number; code?: string }> {
    let status = 0
    const res = {
      status: (code: number) => {
        status = code
        return res
      },
      send: () => res,
    } as unknown as Response
    const req = { params: { workspaceId }, body } as unknown as Request
    try {
      await handlers().syncName(req, res)
      return status
    } catch (error) {
      const { status: errorStatus, code } = error as { status?: number; code?: string }
      return { status: errorStatus, code }
    }
  }

  async function storedName(workspaceId: string) {
    return (await WorkspaceRegistryRepository.findById(pool, workspaceId))?.name
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  beforeEach(() => {
    workos = new StubWorkosOrgService()
  })

  afterAll(async () => {
    await pool.query("DELETE FROM workspace_registry WHERE id = ANY($1)", [workspaceIds])
    await pool.end()
  })

  test("stores the region's current name, trimmed by the shared rule", async () => {
    const workspaceId = await seedWorkspace()

    const result = await sync(workspaceId, { name: "  After  " })

    expect({ result, stored: await storedName(workspaceId) }).toEqual({ result: 204, stored: "After" })
  })

  test("should rename the workspace's WorkOS organization when it has one", async () => {
    const { workspaceId, organizationId } = await seedWorkspaceWithOrganization()

    const result = await sync(workspaceId, { name: "After" })

    expect({ result, organizationName: workos.organizationNames.get(organizationId) }).toEqual({
      result: 204,
      organizationName: "After",
    })
  })

  test("should fail so the region retries when WorkOS rejects the rename", async () => {
    const { workspaceId } = await seedWorkspaceWithOrganization()
    spyOn(workos, "renameOrganization").mockRejectedValue(new Error("WorkOS unavailable"))

    const result = await sync(workspaceId, { name: "After" })

    expect({ result, stored: await storedName(workspaceId) }).toEqual({
      result: { status: undefined, code: undefined },
      stored: "After",
    })
  })

  test("answers 404 for a workspace not registered yet, so the region retries", async () => {
    expect(await sync("ws_missing", { name: "After" })).toEqual({ status: 404, code: "NOT_FOUND" })
  })

  test("rejects a name the creation rule rejects without writing", async () => {
    const workspaceId = await seedWorkspace()

    const result = await sync(workspaceId, { name: " " })

    expect({ result, stored: await storedName(workspaceId) }).toEqual({
      result: { status: 400, code: "VALIDATION_ERROR" },
      stored: "Before",
    })
  })
})
