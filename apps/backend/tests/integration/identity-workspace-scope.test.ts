import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { AccessLogRepository } from "../../src/features/access-log"
import { InvitationRepository } from "../../src/features/invitations"
import { UserRepository, WorkspaceRepository } from "../../src/features/workspaces"
import { invitationId, userId, workspaceId } from "../../src/lib/id"

const FAR_FUTURE = new Date("2099-01-01T00:00:00Z")

const rand = () => Math.random().toString(36).slice(2, 12)
const scope = <T extends { id: string; workspaceId: string | null }>(row: T | null) =>
  row && { id: row.id, workspaceId: row.workspaceId }
const sortedIds = (rows: { id: string }[]) => rows.map((row) => row.id).sort()

describe("Invitation, access-log and user repositories workspace scope (INV-8)", () => {
  const run = rand()
  const email = (label: string) => `${label}-${run}@identity-scope.test`
  const hash = (label: string) => `hash-${label}-${run}`
  const sharedEmail = email("shared")
  const admins = new Map<string, string>()

  let pool: Pool

  let wsA: string
  let wsB: string

  let emailInvA: string
  let emailInvB: string
  let rootA: string
  let rootB: string
  let childPointingAtB: string

  async function seedMember(wid: string) {
    return withTransaction(pool, async (client) => (await addTestMember(client, wid, userId())).id)
  }

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Identity scope ${label}`,
        slug: `identity-scope-${label}-${id}`,
        createdBy: userId(),
      })
    })
    admins.set(id, await seedMember(id))
    return id
  }

  async function seedInvitation(params: {
    workspaceId: string
    kind?: "email" | "link"
    email?: string | null
    status?: string
    tokenHash?: string | null
    parentLinkId?: string | null
    maxUses?: number | null
  }) {
    const id = invitationId()
    const defaultMaxUses = params.kind === "link" ? 1 : null
    await pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, status, token_hash, parent_link_id, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, 'member', $5, $6, $7, $8, $9, $10)`,
      [
        id,
        params.workspaceId,
        params.kind ?? "email",
        params.email ?? null,
        admins.get(params.workspaceId),
        params.status ?? "pending",
        params.tokenHash ?? null,
        params.parentLinkId ?? null,
        params.maxUses === undefined ? defaultMaxUses : params.maxUses,
        FAR_FUTURE,
      ]
    )
    return id
  }

  type InvitationSeed = Parameters<typeof seedInvitation>[0]

  const seedLink = (params: InvitationSeed) => seedInvitation({ ...params, kind: "link" })

  const seedChild = (wid: string, parentLinkId: string, childEmail: string) =>
    seedLink({ workspaceId: wid, parentLinkId, email: childEmail, maxUses: null })

  async function seedAccessRow(params: {
    workspaceId: string | null
    actorId: string
    operation: string
    accessKind: string
    authRef?: string | null
    subjects?: unknown[] | null
  }) {
    const id = `acc_${rand()}`
    await pool.query(
      `INSERT INTO access_log (id, workspace_id, occurred_at, actor_type, actor_id, auth_ref, operation, access_kind, outcome, subjects)
       VALUES ($1, $2, NOW(), 'user', $3, $4, $5, $6, 'success', $7::jsonb)`,
      [
        id,
        params.workspaceId,
        params.actorId,
        params.authRef ?? null,
        params.operation,
        params.accessKind,
        params.subjects ? JSON.stringify(params.subjects) : null,
      ]
    )
    return id
  }

  async function seedReadRows(actorId: string, subjects?: unknown[]) {
    const read = (wid: string | null, operation: string) =>
      seedAccessRow({ workspaceId: wid, actorId, operation, accessKind: "read", subjects })
    const own = await read(wsA, "scope.read")
    await read(wsB, "scope.read")
    const workspaceLess = await read(null, "scope.login")
    return { own, workspaceLess }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")

    emailInvA = await seedInvitation({ workspaceId: wsA, email: sharedEmail })
    emailInvB = await seedInvitation({ workspaceId: wsB, email: sharedEmail })
    rootA = await seedLink({ workspaceId: wsA, tokenHash: hash("a"), maxUses: 2 })
    rootB = await seedLink({ workspaceId: wsB, tokenHash: hash("b"), maxUses: 2 })
    const rootBRevoked = await seedLink({
      workspaceId: wsB,
      status: "revoked",
      tokenHash: hash("b-revoked"),
      maxUses: 2,
    })
    childPointingAtB = await seedChild(wsA, rootBRevoked, sharedEmail)
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("InvitationRepository", () => {
    test("should list every workspace's pending invitation for an email when logging in", async () => {
      const pending = await InvitationRepository.findPendingByEmail(pool, sharedEmail)

      expect(sortedIds(pending)).toEqual([childPointingAtB, emailInvA, emailInvB].sort())
    })

    test("should discover the holding workspace from a token hash or an invitation id", async () => {
      const [root, discoveredFromRoot, discoveredFromEmail, unknown] = await Promise.all([
        InvitationRepository.findRootByTokenHashForUpdate(pool, hash("b")),
        InvitationRepository.findWorkspaceIdByInvitationId(pool, rootB),
        InvitationRepository.findWorkspaceIdByInvitationId(pool, emailInvA),
        InvitationRepository.findWorkspaceIdByInvitationId(pool, invitationId()),
      ])

      expect({
        root: scope(root),
        discoveredFromRoot,
        discoveredFromEmail,
        unknown,
      }).toEqual({
        root: { id: rootB, workspaceId: wsB },
        discoveredFromRoot: wsB,
        discoveredFromEmail: wsA,
        unknown: null,
      })
    })

    test("should insert a child under the parent's workspace and read it back there", async () => {
      const parent = (await InvitationRepository.findById(pool, wsA, rootA))!
      const child = await InvitationRepository.insertOrFindLinkChild(pool, {
        id: invitationId(),
        parent,
        email: email("inserted"),
      })

      expect({ workspaceId: child.workspaceId, parentLinkId: child.parentLinkId, email: child.email }).toEqual({
        workspaceId: wsA,
        parentLinkId: rootA,
        email: email("inserted"),
      })
    })
  })

  describe("AccessLogRepository", () => {
    test("should list a workspace's rows for an actor without another workspace's or a workspace-less row", async () => {
      const actor = `usr_scope_actor_${run}`
      const { own, workspaceLess } = await seedReadRows(actor)

      const [inA, withoutWorkspace] = await Promise.all([
        AccessLogRepository.listByActor(pool, { workspaceId: wsA, actorId: actor }),
        AccessLogRepository.listByActor(pool, { workspaceId: null, actorId: actor }),
      ])

      expect({ inA: inA.map(scope), withoutWorkspace: withoutWorkspace.map(scope) }).toEqual({
        inA: [{ id: own, workspaceId: wsA }],
        withoutWorkspace: [{ id: workspaceLess, workspaceId: null }],
      })
    })

    test("should list a workspace's rows for a subject without another workspace's or a workspace-less row", async () => {
      const subjectId = `stream_scope_subject_${run}`
      const { own, workspaceLess } = await seedReadRows(`usr_scope_subject_actor_${run}`, [
        { type: "stream", id: subjectId },
      ])

      const [inA, withoutWorkspace] = await Promise.all([
        AccessLogRepository.listBySubject(pool, { workspaceId: wsA, subjectType: "stream", subjectId }),
        AccessLogRepository.listBySubject(pool, { workspaceId: null, subjectType: "stream", subjectId }),
      ])

      expect({ inA: inA.map(scope), withoutWorkspace: withoutWorkspace.map(scope) }).toEqual({
        inA: [{ id: own, workspaceId: wsA }],
        withoutWorkspace: [{ id: workspaceLess, workspaceId: null }],
      })
    })
  })

  describe("UserRepository", () => {
    test("should complete setup once when the setup guard is on", async () => {
      const incomplete = await seedMember(wsA)
      await pool.query(`UPDATE users SET setup_completed = false WHERE id = $1`, [incomplete])

      const first = await UserRepository.update(pool, wsA, incomplete, { setupCompleted: true })
      const second = await UserRepository.update(pool, wsA, incomplete, { setupCompleted: true })

      expect({ first: first?.setupCompleted, second }).toEqual({ first: true, second: null })
    })
  })
})
