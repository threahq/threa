import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { generateSlug, StubWorkosOrgService, type WorkosOrgService } from "@threahq/backend-common"
import type { OrgWorkspacePerson } from "@threahq/types"
import { PlatformAdminSyncService } from "../../src/features/platform-admin"
import {
  ControlPlaneWorkspaceService,
  OUTBOX_KV_SYNC,
  OUTBOX_ORG_WORKSPACE_ENSURE,
  OUTBOX_REGIONAL_CREATE,
  WorkosOrganizationProvisioner,
  WorkspaceRegistryRepository,
  type OrgKey,
  type OrgWorkspaceEnsurePayload,
} from "../../src/features/workspaces"
import type { KvClient } from "../../src/lib/cloudflare-kv-client"
import { RegionalClient } from "../../src/lib/regional-client"
import { startMockRegionalBackend, type MockRegionalBackend } from "../mock-regional-backend"
import { setupTestDatabase } from "./setup"

describe("org workspaces", () => {
  let pool: Pool
  let eu: MockRegionalBackend
  let service: ControlPlaneWorkspaceService
  let creator: ControlPlaneWorkspaceService
  let workos: StubWorkosOrgService
  const run = crypto.randomUUID().slice(0, 8)
  const workspaceIds: string[] = []

  const alice: OrgWorkspacePerson = { name: "Alice", email: `alice-${run}@acme.example`, externalIdentity: null }
  const bob: OrgWorkspacePerson = {
    name: "Bob",
    email: null,
    externalIdentity: { provider: "slack", externalTeamId: `T${run}`, externalUserId: "U2" },
  }

  function domainKey(label: string, domain = `${label}-${run}.example`): OrgKey {
    return { kind: "email_domain", domain }
  }

  async function ensure(orgKey: OrgKey, people: OrgWorkspacePerson[], name = `Acme ${run}`) {
    const result = await service.ensureOrgWorkspace({ orgKey, name, region: "eu", people })
    workspaceIds.push(result.workspaceId)
    return result
  }

  async function events(eventType: string, workspaceId: string) {
    const result = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox WHERE event_type = $1 AND payload->>'workspaceId' = $2 ORDER BY id`,
      [eventType, workspaceId]
    )
    return result.rows.map((row) => row.payload)
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
    service = new ControlPlaneWorkspaceService({
      pool,
      regionalClient,
      workosOrgService: {} as WorkosOrgService,
      workosOrganizationProvisioner: {} as WorkosOrganizationProvisioner,
      kvClient: {} as KvClient,
      platformAdminSync: {} as PlatformAdminSyncService,
      availableRegions: ["eu"],
      requireWorkspaceCreationInvite: false,
    })
    workos = new StubWorkosOrgService()
    creator = new ControlPlaneWorkspaceService({
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
      [OUTBOX_ORG_WORKSPACE_ENSURE, OUTBOX_KV_SYNC, OUTBOX_REGIONAL_CREATE],
      workspaceIds,
    ])
    await pool.query("DELETE FROM workspace_memberships WHERE workspace_id = ANY($1)", [workspaceIds])
    await pool.query("DELETE FROM workspace_registry WHERE id = ANY($1)", [workspaceIds])
    await eu.stop()
    await pool.end()
  })

  test("should create one workspace when two calls race on the same org key", async () => {
    const orgKey = domainKey("race")
    // Holding the table until both inserts wait on it makes them overlap.
    const blocker = await pool.connect()
    let results: Awaited<ReturnType<typeof ensure>>[]
    try {
      await blocker.query("BEGIN")
      await blocker.query("LOCK TABLE workspace_registry IN SHARE MODE")
      const racing = Promise.all([ensure(orgKey, [alice]), ensure(orgKey, [bob])])
      await untilBlocked(2, "%INSERT INTO workspace_registry%")
      await blocker.query("COMMIT")
      results = await racing
    } finally {
      blocker.release()
    }
    const ids = new Set(results.map((result) => result.workspaceId))
    const rows = await pool.query<{ id: string }>("SELECT id FROM workspace_registry WHERE org_key = $1", [
      `email_domain:race-${run}.example`,
    ])

    expect({
      ids: [...ids],
      created: results.map((result) => result.created).sort(),
      rows: rows.rows,
    }).toEqual({
      ids: [results[0].workspaceId],
      created: [false, true],
      rows: [{ id: results[0].workspaceId }],
    })
  })

  test("should store an unclaimed connect workspace when it creates the row", async () => {
    const { workspaceId } = await ensure(domainKey("fresh"), [alice])
    const row = await WorkspaceRegistryRepository.findById(pool, workspaceId)

    expect(row).toEqual({
      id: workspaceId,
      name: `Acme ${run}`,
      slug: expect.any(String),
      region: "eu",
      tier: "connect",
      created_by_workos_user_id: null,
      workos_organization_id: null,
      created_at: expect.any(Date),
      updated_at: expect.any(Date),
    })
  })

  test("should enqueue the extra person when a repeat call adds one", async () => {
    const orgKey = domainKey("repeat")
    const first = await ensure(orgKey, [alice])
    const second = await ensure(orgKey, [alice, bob])
    const slug = (await WorkspaceRegistryRepository.findById(pool, first.workspaceId))?.slug
    const base = { workspaceId: first.workspaceId, name: `Acme ${run}`, slug, tier: "connect", region: "eu" }

    expect({
      second,
      ensureEvents: await events(OUTBOX_ORG_WORKSPACE_ENSURE, first.workspaceId),
      kvEvents: await events(OUTBOX_KV_SYNC, first.workspaceId),
    }).toEqual({
      second: { workspaceId: first.workspaceId, created: false },
      ensureEvents: [
        { ...base, people: [alice] },
        { ...base, people: [alice, bob] },
      ],
      kvEvents: [{ workspaceId: first.workspaceId, region: "eu" }],
    })
  })

  test("should POST the payload to the region when the event is dispatched", async () => {
    const { workspaceId } = await ensure(domainKey("dispatch"), [alice, bob])
    const [payload] = (await events(OUTBOX_ORG_WORKSPACE_ENSURE, workspaceId)) as OrgWorkspaceEnsurePayload[]

    await service.ensureOrgWorkspaceInRegion(payload)
    const { region: _region, ...body } = payload

    expect(eu.requests).toEqual([{ method: "POST", url: "/internal/org-workspaces", body }])
  })

  test("should reject the call and store nothing when a person has neither email nor identity", async () => {
    const orgKey = domainKey("nobody")
    const nobody = { name: "Nobody", email: null, externalIdentity: null }

    const error = await service
      .ensureOrgWorkspace({ orgKey, name: `Acme ${run}`, region: "eu", people: [nobody] })
      .then(
        () => null,
        (rejection: unknown) => rejection
      )
    const rows = await pool.query("SELECT id FROM workspace_registry WHERE org_key = $1", [
      `email_domain:nobody-${run}.example`,
    ])

    expect({ error, rows: rows.rows }).toEqual({
      error: expect.objectContaining({ status: 400, code: "VALIDATION_ERROR" }),
      rows: [],
    })
  })

  test("should reject the call and store nothing when the org key could collide with another org", async () => {
    const attempt = (orgKey: OrgKey) =>
      service.ensureOrgWorkspace({ orgKey, name: `Acme ${run}`, region: "eu", people: [alice] }).then(
        () => null,
        (rejection: unknown) => rejection
      )
    const rejected = expect.objectContaining({ status: 400, code: "VALIDATION_ERROR" })

    const errors = {
      blankDomain: await attempt({ kind: "email_domain", domain: "  " }),
      colonProvider: await attempt({ kind: "external_team", provider: `slack:${run}`, externalTeamId: "T1" }),
      blankTeam: await attempt({ kind: "external_team", provider: "slack", externalTeamId: "" }),
    }
    const rows = await pool.query(
      "SELECT org_key FROM workspace_registry WHERE org_key IN ('email_domain:', $1, 'external_team:slack:')",
      [`external_team:slack:${run}:T1`]
    )

    expect({ errors, rows: rows.rows }).toEqual({
      errors: { blankDomain: rejected, colonProvider: rejected, blankTeam: rejected },
      rows: [],
    })
  })

  test("should throw so the outbox retries when the region rejects the payload", async () => {
    const payload: OrgWorkspaceEnsurePayload = {
      workspaceId: `ws_rejected_${run}`,
      name: "Acme",
      slug: `acme-rejected-${run}`,
      tier: "connect",
      region: "eu",
      people: [{ name: "Nobody", email: null, externalIdentity: null }],
    }

    await expect(service.ensureOrgWorkspaceInRegion(payload)).rejects.toThrow("Regional backend returned 400")
  })

  test("should map domains that differ only in case to one workspace when ensured", async () => {
    const first = await ensure(domainKey("case", `Case-${run}.Example`), [alice])
    const second = await ensure(domainKey("case", `case-${run}.EXAMPLE`), [alice])

    expect(second).toEqual({ workspaceId: first.workspaceId, created: false })
  })

  test("should register the workspace and enqueue its regional create and KV sync when a user creates one", async () => {
    const name = `Create ${run}`
    const workosUserId = `user_creator_${run}`
    const email = `creator-${run}@acme.example`
    const workspace = await creator.create({
      name,
      timezone: "Europe/Stockholm",
      workosUserId,
      authUser: { email, firstName: "Cora", lastName: "Reed" },
    })
    workspaceIds.push(workspace.id)
    const slug = generateSlug(name)
    const org = await workos.getOrganizationByExternalId(workspace.id)

    expect({
      workspace,
      row: await WorkspaceRegistryRepository.findById(pool, workspace.id),
      regionalCreate: await events(OUTBOX_REGIONAL_CREATE, workspace.id),
      kvSync: await events(OUTBOX_KV_SYNC, workspace.id),
    }).toEqual({
      workspace: {
        id: workspace.id,
        name,
        slug,
        region: "eu",
        tier: "full",
        createdBy: workosUserId,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
      row: {
        id: workspace.id,
        name,
        slug,
        region: "eu",
        tier: "full",
        created_by_workos_user_id: workosUserId,
        workos_organization_id: org!.id,
        created_at: expect.any(Date),
        updated_at: expect.any(Date),
      },
      regionalCreate: [
        {
          workspaceId: workspace.id,
          name,
          slug,
          region: "eu",
          ownerWorkosUserId: workosUserId,
          ownerEmail: email,
          ownerName: "Cora Reed",
          timezone: "Europe/Stockholm",
        },
      ],
      kvSync: [{ workspaceId: workspace.id, region: "eu" }],
    })
  })

  test("should give a created workspace a fresh slug when an org workspace already holds its slug", async () => {
    const name = `Collide ${run}`
    const org = await ensure(domainKey("collide"), [alice], name)
    const workspace = await creator.create({
      name,
      workosUserId: `user_collide_${run}`,
      authUser: { email: `collide-${run}@acme.example` },
    })
    workspaceIds.push(workspace.id)
    const [regionalCreate] = (await events(OUTBOX_REGIONAL_CREATE, workspace.id)) as { slug: string }[]

    expect({
      orgSlug: (await WorkspaceRegistryRepository.findById(pool, org.workspaceId))?.slug,
      createdSlug: workspace.slug,
      enqueuedSlug: regionalCreate?.slug,
    }).toEqual({
      orgSlug: generateSlug(name),
      createdSlug: `${generateSlug(name)}-1`,
      enqueuedSlug: `${generateSlug(name)}-1`,
    })
  })
})
