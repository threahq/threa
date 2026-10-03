import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { AccessLogRepository } from "../../src/features/access-log"
import { AIUsageRepository } from "../../src/features/ai-usage"
import { InvitationRepository } from "../../src/features/invitations"
import { UserRepository, WorkspaceRepository } from "../../src/features/workspaces"
import { invitationId, userId, workspaceId } from "../../src/lib/id"

const FAR_FUTURE = new Date("2099-01-01T00:00:00Z")
const PAST = new Date("2020-01-01T00:00:00Z")

const rand = () => Math.random().toString(36).slice(2, 12)
const scope = <T extends { id: string; workspaceId: string | null }>(row: T | null) =>
  row && { id: row.id, workspaceId: row.workspaceId }
const sortedIds = (rows: { id: string }[]) => rows.map((row) => row.id).sort()

describe("Invitation, access-log, AI usage and user repositories workspace scope (INV-8)", () => {
  const run = rand()
  const email = (label: string) => `${label}-${run}@identity-scope.test`
  const hash = (label: string) => `hash-${label}-${run}`
  const sharedEmail = email("shared")
  const childEmailA = email("child-a")
  const childEmailB = email("child-b")
  const admins = new Map<string, string>()

  let pool: Pool

  let wsA: string
  let wsB: string
  let wsC: string

  let listEmailC: string
  let listRootC: string
  let listRevokedC: string

  let emailInvA: string
  let emailInvB: string
  let rootA: string
  let rootB: string
  let legacyAdminB: string
  let expiringB: string
  let childA: string
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
    role?: string
    status?: string
    tokenHash?: string | null
    parentLinkId?: string | null
    maxUses?: number | null
    expiresAt?: Date | null
    acceptedAt?: Date | null
  }) {
    const id = invitationId()
    const defaultMaxUses = params.kind === "link" ? 1 : null
    await pool.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email, role, invited_by, status, token_hash, parent_link_id, max_uses, expires_at, accepted_at, acceptance_consumes_capacity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        params.workspaceId,
        params.kind ?? "email",
        params.email ?? null,
        params.role ?? "member",
        admins.get(params.workspaceId),
        params.status ?? "pending",
        params.tokenHash ?? null,
        params.parentLinkId ?? null,
        params.maxUses === undefined ? defaultMaxUses : params.maxUses,
        params.expiresAt === undefined ? FAR_FUTURE : params.expiresAt,
        params.acceptedAt ?? null,
        params.acceptedAt ? true : null,
      ]
    )
    return id
  }

  type InvitationSeed = Parameters<typeof seedInvitation>[0]

  const seedLink = (params: InvitationSeed) => seedInvitation({ ...params, kind: "link" })

  const seedChild = (wid: string, parentLinkId: string, childEmail: string, extras: Partial<InvitationSeed> = {}) =>
    seedLink({ workspaceId: wid, parentLinkId, email: childEmail, maxUses: null, ...extras })

  async function invitationRow(id: string) {
    const result = await pool.query(
      `SELECT workspace_id, status, email, revision, max_uses, accepted_at IS NOT NULL AS accepted FROM workspace_invitations WHERE id = $1`,
      [id]
    )
    return result.rows[0]
  }

  async function seedAccessRow(params: {
    workspaceId: string | null
    actorId: string
    operation: string
    accessKind: string
    authRef?: string | null
    subjects?: unknown[] | null
    occurredAt?: Date
  }) {
    const id = `acc_${rand()}`
    await pool.query(
      `INSERT INTO access_log (id, workspace_id, occurred_at, actor_type, actor_id, auth_ref, operation, access_kind, outcome, subjects)
       VALUES ($1, $2, COALESCE($3, NOW()), 'user', $4, $5, $6, $7, 'success', $8::jsonb)`,
      [
        id,
        params.workspaceId,
        params.occurredAt ?? null,
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

  async function seedUsage(wid: string, user: string | null, createdAt: Date) {
    const id = `usage_${rand()}`
    await pool.query(
      `INSERT INTO ai_usage_records (id, workspace_id, function_id, model, provider, total_tokens, cost_usd, user_id, created_at)
       VALUES ($1, $2, 'identity-scope', 'model-x', 'provider-x', 10, 0.01, $3, $4)`,
      [id, wid, user, createdAt]
    )
    return id
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    wsC = await seedWorkspace("c")

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
    legacyAdminB = await seedLink({ workspaceId: wsB, role: "admin", tokenHash: hash("b-admin") })
    expiringB = await seedInvitation({ workspaceId: wsB, email: email("expiring-b"), expiresAt: PAST })
    childA = await seedChild(wsA, rootA, childEmailA)
    await seedChild(wsB, rootA, childEmailB, { status: "accepted", acceptedAt: new Date() })
    await seedChild(wsB, rootA, email("child-b2"))
    listEmailC = await seedInvitation({ workspaceId: wsC, email: email("list-c") })
    listRootC = await seedLink({ workspaceId: wsC, tokenHash: hash("c") })
    listRevokedC = await seedLink({ workspaceId: wsC, status: "revoked", tokenHash: hash("c-revoked") })
    childPointingAtB = await seedChild(wsA, rootBRevoked, sharedEmail)
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("InvitationRepository", () => {
    test("should find an invitation only through the workspace that holds it", async () => {
      const [fromA, fromWrong, fromOwner, lockedFromA, lockedFromWrong] = await Promise.all([
        InvitationRepository.findById(pool, wsA, emailInvA),
        InvitationRepository.findById(pool, wsA, emailInvB),
        InvitationRepository.findById(pool, wsB, emailInvB),
        InvitationRepository.findByIdForUpdate(pool, wsA, emailInvA),
        InvitationRepository.findByIdForUpdate(pool, wsA, emailInvB),
      ])

      expect({
        fromA: scope(fromA),
        fromWrong,
        fromOwner: scope(fromOwner),
        lockedFromA: scope(lockedFromA),
        lockedFromWrong,
      }).toEqual({
        fromA: { id: emailInvA, workspaceId: wsA },
        fromWrong: null,
        fromOwner: { id: emailInvB, workspaceId: wsB },
        lockedFromA: { id: emailInvA, workspaceId: wsA },
        lockedFromWrong: null,
      })
    })

    test("should not lock another workspace's invitation when its id is locked with this workspace", async () => {
      const locker = await pool.connect()
      try {
        await locker.query("BEGIN")
        const locked = await InvitationRepository.findByIdForUpdate(locker, wsA, emailInvB)
        const probe = await pool.query(`SELECT id FROM workspace_invitations WHERE id = $1 FOR UPDATE SKIP LOCKED`, [
          emailInvB,
        ])

        expect({ locked, probed: probe.rows.map((row) => row.id) }).toEqual({ locked: null, probed: [emailInvB] })
      } finally {
        await locker.query("ROLLBACK")
        locker.release()
      }
    })

    test("should count only the workspace's own accepted children when another workspace has a child under the same parent id", async () => {
      const root = await InvitationRepository.findById(pool, wsA, rootA)

      expect(root?.useCount).toBe(0)
    })

    test("should not accept or bump the revision of another workspace's invitation when its id is passed with this workspace", async () => {
      const accepted = await InvitationRepository.accept(pool, wsA, emailInvB, new Date(), "workos_decoy", true)
      await InvitationRepository.incrementRevision(pool, wsA, emailInvB)

      expect({ accepted, row: await invitationRow(emailInvB) }).toEqual({
        accepted: false,
        row: { workspace_id: wsB, status: "pending", email: sharedEmail, revision: 1, max_uses: null, accepted: false },
      })
    })

    test("should accept and bump the revision of this workspace's own invitation", async () => {
      const own = await seedInvitation({ workspaceId: wsA, email: email("own") })

      const accepted = await InvitationRepository.accept(pool, wsA, own, new Date(), null, false)
      await InvitationRepository.incrementRevision(pool, wsA, own)

      expect({ accepted, row: await invitationRow(own) }).toEqual({
        accepted: true,
        row: {
          workspace_id: wsA,
          status: "accepted",
          email: email("own"),
          revision: 2,
          max_uses: null,
          accepted: true,
        },
      })
    })

    test("should not revoke another workspace's invitation when its id is passed with this workspace", async () => {
      const revoked = await InvitationRepository.revoke(pool, emailInvB, wsA, new Date())

      expect({ revoked, row: await invitationRow(emailInvB) }).toEqual({
        revoked: null,
        row: { workspace_id: wsB, status: "pending", email: sharedEmail, revision: 1, max_uses: null, accepted: false },
      })
    })

    test("should not update another workspace's link when its id is passed with this workspace", async () => {
      const updated = await InvitationRepository.updateLink(pool, rootB, wsA, { maxUses: 9 })

      expect({ updated, row: await invitationRow(rootB) }).toEqual({
        updated: null,
        row: { workspace_id: wsB, status: "pending", email: null, revision: 1, max_uses: 2, accepted: false },
      })
    })

    test("should not bind another workspace's legacy admin link when its id is passed with this workspace", async () => {
      const claimed = await InvitationRepository.claimLegacyAdminLink(pool, wsA, legacyAdminB, email("claim"))

      expect({ claimed, row: await invitationRow(legacyAdminB) }).toEqual({
        claimed: null,
        row: { workspace_id: wsB, status: "pending", email: null, revision: 1, max_uses: 1, accepted: false },
      })
    })

    test("should find only this workspace's child when another workspace has a child under the same parent link", async () => {
      const [own, foreign] = await Promise.all([
        InvitationRepository.findLinkChild(pool, wsA, rootA, childEmailA),
        InvitationRepository.findLinkChild(pool, wsA, rootA, childEmailB),
      ])

      expect({ own: own?.id, foreign }).toEqual({ own: childA, foreign: null })
    })

    test("should count only this workspace's pending children when another workspace has children under the same parent", async () => {
      const pending = await InvitationRepository.countPendingLinkChildren(pool, wsA, rootA)

      expect(pending).toBe(1)
    })

    test("should list only this workspace's root invitations when another workspace has roots", async () => {
      const [all, pending] = await Promise.all([
        InvitationRepository.listByWorkspace(pool, wsC),
        InvitationRepository.listByWorkspace(pool, wsC, { status: "pending" }),
      ])

      expect({ all: sortedIds(all), pending: sortedIds(pending) }).toEqual({
        all: [listEmailC, listRootC, listRevokedC].sort(),
        pending: [listEmailC, listRootC].sort(),
      })
    })

    test("should ignore a parent in another workspace when listing a workspace's pending invitations by email", async () => {
      const pending = await InvitationRepository.findPendingByEmailsAndWorkspace(pool, [sharedEmail], wsA)

      expect(sortedIds(pending)).toEqual([childPointingAtB, emailInvA].sort())
    })

    test("should list every workspace's pending invitation for an email when logging in", async () => {
      const pending = await InvitationRepository.findPendingByEmail(pool, sharedEmail)

      expect(sortedIds(pending)).toEqual([childPointingAtB, emailInvA, emailInvB].sort())
    })

    test("should only expire this workspace's invitations when another workspace has an elapsed one", async () => {
      const expired = await InvitationRepository.markExpired(pool, wsA)

      expect({ expired, row: await invitationRow(expiringB) }).toEqual({
        expired: 0,
        row: {
          workspace_id: wsB,
          status: "pending",
          email: email("expiring-b"),
          revision: 1,
          max_uses: null,
          accepted: false,
        },
      })
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

    test("should reconstruct deliveries from this workspace's subscribe rows, unsubscribe rows and events only", async () => {
      const streamId = `stream_scope_delivery_${run}`
      const connA = `sconn_scope_a_${run}`
      const connB = `sconn_scope_b_${run}`
      const actorA = `usr_scope_delivery_a_${run}`
      const actorB = `usr_scope_delivery_b_${run}`
      const base = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 15, 10, 0, 0)
      const at = (offsetMs: number) => new Date(base + offsetMs)
      const subjects = [{ type: "stream", id: streamId }]
      const seedSocketRow = (wid: string, actor: string, kind: "subscribe" | "unsubscribe", conn: string, ms: number) =>
        seedAccessRow({
          workspaceId: wid,
          actorId: actor,
          operation: `socket.${kind}`,
          accessKind: kind,
          authRef: conn,
          subjects,
          occurredAt: at(ms),
        })
      const insertEvent = async (wid: string, sequence: number, actor: string, createdAt: Date) => {
        const id = `evt_scope_${rand()}`
        await pool.query(
          `INSERT INTO stream_events (id, workspace_id, stream_id, sequence, event_type, actor_id, actor_type, payload, created_at)
           VALUES ($1, $2, $3, $4, 'message_created', $5, 'user', '{}'::jsonb, $6)`,
          [id, wid, streamId, sequence, actor, createdAt]
        )
        return id
      }

      await seedSocketRow(wsA, actorA, "subscribe", connA, 0)
      await seedSocketRow(wsB, actorB, "subscribe", connB, 500)
      await seedSocketRow(wsB, actorB, "unsubscribe", connA, 1000)
      await seedSocketRow(wsA, actorA, "unsubscribe", connA, 4000)
      const ownEvent = await insertEvent(wsA, 1, actorA, at(2000))
      await insertEvent(wsB, 2, actorB, at(2500))

      const delivered = await AccessLogRepository.reconstructDeliveredEvents(pool, {
        clockSkewToleranceMs: 0,
        workspaceId: wsA,
        streamId,
        from: at(-60_000),
        to: at(60_000),
      })

      expect(delivered).toEqual([
        {
          actorId: actorA,
          actorType: "user",
          authRef: connA,
          eventId: ownEvent,
          sequence: 1,
          eventType: "message_created",
          eventActorId: actorA,
          eventActorType: "user",
          createdAt: at(2000),
        },
      ])
    })
  })

  describe("AIUsageRepository.listRecent", () => {
    test("should list a workspace's usage for a user without another workspace's rows for the same user id", async () => {
      const user = userId()
      const ownOld = await seedUsage(wsA, user, new Date("2026-01-01T00:00:00Z"))
      const ownNew = await seedUsage(wsA, user, new Date("2026-01-02T00:00:00Z"))
      const ownOther = await seedUsage(wsA, userId(), new Date("2026-01-03T00:00:00Z"))
      await seedUsage(wsB, user, new Date("2026-01-04T00:00:00Z"))

      const [forUser, all] = await Promise.all([
        AIUsageRepository.listRecent(pool, wsA, { userId: user, limit: 10 }),
        AIUsageRepository.listRecent(pool, wsA, { limit: 10 }),
      ])

      expect({
        forUser: forUser.map((r) => r.id),
        all: all.map((r) => r.id),
      }).toEqual({
        forUser: [ownNew, ownOld],
        all: [ownOther, ownNew, ownOld],
      })
    })
  })

  describe("UserRepository", () => {
    test("should not update another workspace's user when its id is passed with this workspace", async () => {
      const own = await seedMember(wsA)
      const foreign = await seedMember(wsB)

      const [updatedForeign, updatedOwn] = await Promise.all([
        UserRepository.update(pool, wsA, foreign, { name: "Hijacked" }),
        UserRepository.update(pool, wsA, own, { name: "Renamed" }),
      ])
      const names = await pool.query(
        `SELECT id, workspace_id, name FROM users WHERE id = ANY($1) ORDER BY workspace_id`,
        [[own, foreign]]
      )

      expect({ updatedForeign, updatedOwn: updatedOwn?.name, names: names.rows }).toEqual({
        updatedForeign: null,
        updatedOwn: "Renamed",
        names: [
          { id: own, workspace_id: wsA, name: "Renamed" },
          { id: foreign, workspace_id: wsB, name: expect.not.stringMatching(/^Hijacked$/) },
        ],
      })
    })

    test("should complete setup once when the setup guard is on", async () => {
      const incomplete = await seedMember(wsA)
      await pool.query(`UPDATE users SET setup_completed = false WHERE id = $1`, [incomplete])

      const first = await UserRepository.update(pool, wsA, incomplete, { setupCompleted: true })
      const second = await UserRepository.update(pool, wsA, incomplete, { setupCompleted: true })

      expect({ first: first?.setupCompleted, second }).toEqual({ first: true, second: null })
    })

    test("should set the avatar from this workspace's latest upload when another workspace has a newer upload for the same user id", async () => {
      const user = await seedMember(wsA)
      const ownUpload = `avup_scope_own_${run}`
      const foreignUpload = `avup_scope_foreign_${run}`
      await pool.query(
        `INSERT INTO avatar_uploads (id, workspace_id, user_id, raw_s3_key, created_at) VALUES ($1, $2, $3, 'k/own', $4), ($5, $6, $3, 'k/foreign', $7)`,
        [ownUpload, wsA, user, new Date("2026-01-01T00:00:00Z"), foreignUpload, wsB, new Date("2026-01-02T00:00:00Z")]
      )

      const updated = await UserRepository.updateAvatarIfLatestUpload(
        pool,
        wsA,
        user,
        ownUpload,
        "https://avatar.test/own.png"
      )

      expect(updated?.avatarUrl).toBe("https://avatar.test/own.png")
    })

    test("should not set another workspace's user avatar when its id is passed with this workspace", async () => {
      const foreign = await seedMember(wsB)
      const upload = `avup_scope_cross_${run}`
      await pool.query(
        `INSERT INTO avatar_uploads (id, workspace_id, user_id, raw_s3_key) VALUES ($1, $2, $3, 'k/cross')`,
        [upload, wsA, foreign]
      )

      const updated = await UserRepository.updateAvatarIfLatestUpload(
        pool,
        wsA,
        foreign,
        upload,
        "https://avatar.test/hijack.png"
      )
      const stored = await pool.query(`SELECT avatar_url FROM users WHERE id = $1`, [foreign])

      expect({ updated, avatarUrl: stored.rows[0].avatar_url }).toEqual({ updated: null, avatarUrl: null })
    })
  })
})
