import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { StubWorkosOrgService } from "@threahq/backend-common"
import { PlatformAdminSyncService } from "../../src/features/platform-admin"
import {
  ControlPlaneWorkspaceService,
  OUTBOX_KV_SYNC,
  OUTBOX_ORG_WORKSPACE_CLAIM,
  OUTBOX_ORG_WORKSPACE_ENSURE,
  OUTBOX_REGIONAL_CREATE,
  WorkosOrganizationProvisioner,
  WorkspaceRegistryRepository,
  type OrgWorkspaceClaimPayload,
} from "../../src/features/workspaces"
import type { KvClient } from "../../src/lib/cloudflare-kv-client"
import { RegionalClient } from "../../src/lib/regional-client"
import { startMockRegionalBackend, type MockRegionalBackend } from "../mock-regional-backend"
import { setupTestDatabase } from "./setup"

describe("org workspace claim", () => {
  let pool: Pool
  let eu: MockRegionalBackend
  let service: ControlPlaneWorkspaceService
  let workos: StubWorkosOrgService
  const run = crypto.randomUUID().slice(0, 8)
  const workspaceIds: string[] = []

  async function seed(label: string) {
    const domain = `${label}-${run}.example`
    const result = await service.ensureOrgWorkspace({
      orgKey: { kind: "email_domain", domain },
      name: `Acme ${label} ${run}`,
      region: "eu",
      people: [],
    })
    workspaceIds.push(result.workspaceId)
    return { workspaceId: result.workspaceId, domain }
  }

  function signIn(workosUserId: string, email: string, emailVerified = true) {
    return service.claimOrgWorkspaces({ workosUserId, email, emailVerified, name: workosUserId })
  }

  async function claimEvents(workspaceId: string) {
    const result = await pool.query<{ payload: OrgWorkspaceClaimPayload }>(
      `SELECT payload FROM outbox WHERE event_type = $1 AND payload->>'workspaceId' = $2 ORDER BY id`,
      [OUTBOX_ORG_WORKSPACE_CLAIM, workspaceId]
    )
    return result.rows.map((row) => row.payload)
  }

  async function memberIds(workspaceId: string) {
    const result = await pool.query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM workspace_memberships WHERE workspace_id = $1 ORDER BY workos_user_id`,
      [workspaceId]
    )
    return result.rows.map((row) => row.workos_user_id)
  }

  async function untilBlocked(count: number, pattern: string) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const result = await pool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [pattern]
      )
      if ((result.rows[0]?.waiting ?? 0) >= count) return
      await Bun.sleep(20)
    }
    throw new Error(`Timed out waiting for ${count} backends blocked on ${pattern}`)
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eu = await startMockRegionalBackend()
    const regionalClient = new RegionalClient({ eu: { internalUrl: eu.url } }, "test-key")
    workos = new StubWorkosOrgService()
    service = new ControlPlaneWorkspaceService({
      pool,
      regionalClient,
      workosOrgService: workos,
      workosOrganizationProvisioner: new WorkosOrganizationProvisioner({ pool, workosOrgService: workos }),
      kvClient: {} as KvClient,
      platformAdminSync: new PlatformAdminSyncService({ pool, regionalClient }),
      availableRegions: ["eu"],
      requireWorkspaceCreationInvite: false,
    })
  })

  beforeEach(() => {
    eu.reset()
  })

  afterAll(async () => {
    await pool.query("DELETE FROM outbox WHERE event_type = ANY($1) AND payload->>'workspaceId' = ANY($2)", [
      [OUTBOX_ORG_WORKSPACE_CLAIM, OUTBOX_ORG_WORKSPACE_ENSURE, OUTBOX_KV_SYNC, OUTBOX_REGIONAL_CREATE],
      workspaceIds,
    ])
    await pool.query("DELETE FROM workspace_memberships WHERE workspace_id = ANY($1)", [workspaceIds])
    await pool.query("DELETE FROM workspace_registry WHERE id = ANY($1)", [workspaceIds])
    await eu.stop()
    await pool.end()
  })

  test("should make exactly one owner when two people on the domain sign in at once", async () => {
    const { workspaceId, domain } = await seed("race")
    const alice = `user_alice_${run}`
    const bob = `user_bob_${run}`

    // Holding the table until both creator CAS updates wait on it makes the claims overlap.
    const blocker = await pool.connect()
    try {
      await blocker.query("BEGIN")
      await blocker.query("LOCK TABLE workspace_registry IN SHARE MODE")
      const racing = Promise.all([signIn(alice, `Alice@${domain.toUpperCase()}`), signIn(bob, `bob@${domain}`)])
      await untilBlocked(2, "%UPDATE workspace_registry SET created_by_workos_user_id%")
      await blocker.query("COMMIT")
      await racing
    } finally {
      blocker.release()
    }

    const registry = await WorkspaceRegistryRepository.findById(pool, workspaceId)
    const owner = registry!.created_by_workos_user_id!
    const member = owner === alice ? bob : alice
    const emails: Record<string, string> = { [alice]: `alice@${domain}`, [bob]: `bob@${domain}` }
    const events = await claimEvents(workspaceId)
    expect({
      members: await memberIds(workspaceId),
      events: [...events].sort((a, b) => a.role.localeCompare(b.role)),
    }).toEqual({
      members: [alice, bob].sort(),
      events: [
        { workspaceId, region: "eu", workosUserId: member, email: emails[member]!, name: member, role: "member" },
        { workspaceId, region: "eu", workosUserId: owner, email: emails[owner]!, name: owner, role: "owner" },
      ],
    })

    const orgId = registry!.workos_organization_id
    expect(orgId).not.toBeNull()
    const memberships = await workos.listOrganizationMemberships(orgId!)
    expect(
      memberships
        .map((m) => ({ userId: m.userId, roleSlugs: m.roleSlugs }))
        .sort((a, b) => a.userId.localeCompare(b.userId))
    ).toEqual(
      [
        { userId: owner, roleSlugs: ["owner"] },
        { userId: member, roleSlugs: ["member"] },
      ].sort((a, b) => a.userId.localeCompare(b.userId))
    )
  })

  test("should do nothing when the email is unverified or only a subdomain matches", async () => {
    const { workspaceId, domain } = await seed("ignored")

    await signIn(`user_unverified_${run}`, `carol@${domain}`, false)
    await signIn(`user_subdomain_${run}`, `dave@sub.${domain}`)

    const registry = await WorkspaceRegistryRepository.findById(pool, workspaceId)
    expect({
      members: await memberIds(workspaceId),
      events: await claimEvents(workspaceId),
      creator: registry!.created_by_workos_user_id,
      orgId: registry!.workos_organization_id,
    }).toEqual({ members: [], events: [], creator: null, orgId: null })
  })

  test("should not enqueue another claim when the same person signs in again", async () => {
    const { workspaceId, domain } = await seed("repeat")
    const erin = `user_erin_${run}`

    await signIn(erin, `erin@${domain}`)
    await signIn(erin, `erin@${domain}`)

    expect(await claimEvents(workspaceId)).toEqual([
      { workspaceId, region: "eu", workosUserId: erin, email: `erin@${domain}`, name: erin, role: "owner" },
    ])
  })

  test("should sync the WorkOS owner membership on a later sign-in when the first sync failed", async () => {
    const { workspaceId, domain } = await seed("resync")
    const gina = `user_gina_${run}`
    const failOnce = spyOn(workos, "ensureOrganizationMembership").mockRejectedValueOnce(new Error("WorkOS down"))

    try {
      await signIn(gina, `gina@${domain}`)
      const orgId = (await WorkspaceRegistryRepository.findById(pool, workspaceId))!.workos_organization_id!
      expect(await workos.listOrganizationMemberships(orgId)).toEqual([])

      await signIn(gina, `gina@${domain}`)

      expect({
        memberships: (await workos.listOrganizationMemberships(orgId)).map((m) => ({
          userId: m.userId,
          roleSlugs: m.roleSlugs,
        })),
        events: await claimEvents(workspaceId),
      }).toEqual({
        memberships: [{ userId: gina, roleSlugs: ["owner"] }],
        events: [{ workspaceId, region: "eu", workosUserId: gina, email: `gina@${domain}`, name: gina, role: "owner" }],
      })
    } finally {
      failOnce.mockRestore()
    }
  })

  test("should post the claim to the region when the outbox event is dispatched", async () => {
    const payload: OrgWorkspaceClaimPayload = {
      workspaceId: `ws_dispatch_${run}`,
      region: "eu",
      workosUserId: `user_frank_${run}`,
      email: `frank@dispatch-${run}.example`,
      name: "Frank",
      role: "owner",
    }

    await service.claimOrgWorkspaceInRegion(payload)

    const { region: _region, ...body } = payload
    expect(eu.requests).toEqual([{ method: "POST", url: "/internal/org-workspaces/claim", body }])
  })
})
