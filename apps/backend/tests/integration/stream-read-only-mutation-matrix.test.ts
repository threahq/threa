import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import {
  assertStreamWritable,
  StreamEventRepository,
  StreamMemberRepository,
  StreamRepository,
  StreamService,
} from "../../src/features/streams"
import { eventId, streamId, userId, workspaceId } from "../../src/lib/id"

const rejection = (reason: string) => ({ status: 403, code: "STREAM_READ_ONLY", details: { reason } })

describe("synchronous stream read-only mutation matrix", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let workspace: string
  let member: string
  let outsider: string
  let otherWorkspace: string
  let otherMember: string

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("stream_read_only_mutation_matrix")
    pool = isolated.pool
    cleanup = isolated.cleanup
    workspace = workspaceId()
    member = userId()
    outsider = userId()
    otherWorkspace = workspaceId()
    otherMember = userId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, { id: workspace, name: "Matrix", slug: workspace, createdBy: member })
      member = (await addTestMember(client, workspace, member)).id
      outsider = (await addTestMember(client, workspace, outsider)).id
      await WorkspaceRepository.insert(client, {
        id: otherWorkspace,
        name: "Other Matrix",
        slug: otherWorkspace,
        createdBy: otherMember,
      })
      otherMember = (await addTestMember(client, otherWorkspace, otherMember)).id
    })
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seed(overrides: Partial<Parameters<typeof StreamRepository.insert>[1]> = {}) {
    const id = streamId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id,
        workspaceId: workspace,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: member,
        ...overrides,
      })
      await StreamMemberRepository.insert(client, id, member)
    })
    return id
  }

  test("real schema returns exact direct, inherited, system, and public nonparticipant reasons", async () => {
    const direct = await seed()
    const root = await seed()
    const thread = await seed({ type: "thread", rootStreamId: root, parentStreamId: root })
    const system = await seed({ type: "system" })
    const publicStream = await seed({ visibility: "public" })
    await pool.query("UPDATE streams SET archived_at = NOW() WHERE id = ANY($1)", [[direct, root]])

    const check = (id: string, principal = member) =>
      withTransaction(pool, (client) =>
        assertStreamWritable(client, {
          workspaceId: workspace,
          streamId: id,
          principal: { kind: "user", userId: principal },
        })
      )
    await expect(check(direct)).rejects.toMatchObject(rejection("archived"))
    await expect(check(thread)).rejects.toMatchObject(rejection("archived"))
    await expect(check(system)).rejects.toMatchObject(rejection("system_stream"))
    await expect(check(publicStream, outsider)).rejects.toMatchObject(rejection("not_a_member"))
  })

  test("private and cross-workspace targets remain hidden and denied metadata writes leave no outbox", async () => {
    const privateStream = await seed()
    const archived = await seed()
    const foreign = streamId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: foreign,
        workspaceId: otherWorkspace,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: otherMember,
      })
      await StreamMemberRepository.insert(client, foreign, otherMember)
    })
    await pool.query("UPDATE streams SET archived_at = NOW() WHERE id = $1", [archived])
    const service = new StreamService(pool)

    await expect(
      withTransaction(pool, (client) =>
        assertStreamWritable(client, {
          workspaceId: workspace,
          streamId: privateStream,
          principal: { kind: "user", userId: outsider },
        })
      )
    ).rejects.toMatchObject({ status: 404, code: "STREAM_NOT_FOUND" })
    await expect(
      withTransaction(pool, (client) =>
        assertStreamWritable(client, {
          workspaceId: workspace,
          streamId: foreign,
          principal: { kind: "user", userId: member },
        })
      )
    ).rejects.toMatchObject({ status: 404, code: "STREAM_NOT_FOUND" })
    await expect(
      service.updateStream(
        archived,
        { displayName: "forbidden" },
        { workspaceId: workspace, principal: { kind: "user", userId: member } }
      )
    ).rejects.toMatchObject(rejection("archived"))
    const rows = await pool.query("SELECT display_name FROM streams WHERE id = $1", [archived])
    const outbox = await pool.query("SELECT 1 FROM outbox WHERE payload->>'streamId' = $1", [archived])
    expect({ displayName: rows.rows[0].display_name, outboxRows: outbox.rowCount }).toEqual({
      displayName: null,
      outboxRows: 0,
    })
  })

  test("production stream mutation services preserve authority reasons before legacy eligibility", async () => {
    const archivedScratchpad = await seed({ type: "scratchpad", displayName: "Protected" })
    const system = await seed({ type: "system", createdBy: outsider })
    const publicStream = await seed({ visibility: "public" })
    await pool.query("UPDATE streams SET archived_at = NOW() WHERE id = $1", [archivedScratchpad])
    const service = new StreamService(pool)

    await expect(
      service.updateStream(
        system,
        { displayName: "forbidden" },
        { workspaceId: workspace, principal: { kind: "user", userId: member } }
      )
    ).rejects.toMatchObject(rejection("system_stream"))
    await expect(service.updateCompanionMode(publicStream, workspace, "off", null, outsider)).rejects.toMatchObject(
      rejection("not_a_member")
    )
    await expect(
      service.setStreamToolPolicy(workspace, system, ["web"], { kind: "user", userId: member })
    ).rejects.toMatchObject(rejection("system_stream"))
    await expect(
      service.regenerateDisplayName(workspace, archivedScratchpad, { kind: "user", userId: member })
    ).rejects.toMatchObject(rejection("archived"))

    const rows = await pool.query(
      "SELECT id, display_name, companion_mode FROM streams WHERE id = ANY($1) ORDER BY id",
      [[system, publicStream, archivedScratchpad]]
    )
    const policies = await pool.query("SELECT stream_id FROM stream_policies WHERE stream_id = ANY($1)", [
      [system, publicStream, archivedScratchpad],
    ])
    const outbox = await pool.query("SELECT id FROM outbox WHERE payload->>'streamId' = ANY($1)", [
      [system, publicStream, archivedScratchpad],
    ])
    expect({
      streams: rows.rows,
      policies: policies.rows,
      outbox: outbox.rows,
    }).toEqual({
      streams: expect.arrayContaining([
        expect.objectContaining({ id: system, display_name: null }),
        expect.objectContaining({ id: publicStream, companion_mode: "off" }),
        expect.objectContaining({ id: archivedScratchpad, display_name: "Protected" }),
      ]),
      policies: [],
      outbox: [],
    })
  })

  test("public nonparticipants cannot create threads", async () => {
    const root = await seed({ visibility: "public" })
    const anchor = await StreamEventRepository.insert(pool, {
      id: eventId(),
      streamId: root,
      eventType: "delegation:created",
      payload: {},
      actorId: member,
      actorType: "user",
    })

    await expect(
      new StreamService(pool).createThread({
        workspaceId: workspace,
        parentStreamId: root,
        parentAnchorId: anchor.id,
        createdBy: outsider,
        principal: { kind: "user", userId: outsider },
      })
    ).rejects.toMatchObject(rejection("not_a_member"))

    const threads = await pool.query("SELECT id FROM streams WHERE parent_stream_id = $1", [root])
    const outbox = await pool.query("SELECT id FROM outbox WHERE payload->>'parentStreamId' = $1", [root])
    expect({ threads: threads.rows, outbox: outbox.rows }).toEqual({ threads: [], outbox: [] })
  })

  test("archive transition contends with the stable authority lock", async () => {
    const id = await seed()
    const locker = await pool.connect()
    const archiver = await pool.connect()
    try {
      await locker.query("BEGIN")
      await assertStreamWritable(locker, {
        workspaceId: workspace,
        streamId: id,
        principal: { kind: "user", userId: member },
      })
      await archiver.query("BEGIN")
      let finished = false
      const transition = archiver.query("UPDATE streams SET archived_at = NOW() WHERE id = $1", [id]).then(() => {
        finished = true
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(finished).toBe(false)
      await locker.query("COMMIT")
      await transition
      await archiver.query("COMMIT")
      await expect(
        withTransaction(pool, (client) =>
          assertStreamWritable(client, {
            workspaceId: workspace,
            streamId: id,
            principal: { kind: "user", userId: member },
          })
        )
      ).rejects.toMatchObject(rejection("archived"))
    } finally {
      await locker.query("ROLLBACK").catch(() => {})
      await archiver.query("ROLLBACK").catch(() => {})
      locker.release()
      archiver.release()
    }
  })
})
