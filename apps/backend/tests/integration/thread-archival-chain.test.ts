/**
 * Archiving writes one row; every stream nested beneath it inherits the seal
 * on read, down any depth of `parent_stream_id`, and releases the moment the
 * ancestor is unarchived. Chain under test:
 *
 *   A (channel) > B > C > D          B is archived in most cases
 *   A > E                            sibling that never seals
 *   A > F (archived itself) > G      an own-archived branch the cascade stops at
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { HttpError } from "@threahq/backend-common"
import { ActivityTypes, StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { ActivityRepository } from "../../src/features/activity"
import { BotRuntimeSessionLinkRepository } from "../../src/features/bot-runtimes"
import {
  assertStreamWritable,
  StreamMemberRepository,
  StreamRepository,
  StreamService,
} from "../../src/features/streams"
import { lockEffectiveStreams } from "../../src/features/streams/write-authority"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { botRuntimeSessionLinkId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("thread archival chain", () => {
  let pool: Pool
  let service: StreamService
  let workspace: string
  let owner: string
  let author: string
  let bystander: string
  const ids = { A: "", B: "", C: "", D: "", E: "", F: "", G: "" }

  async function insertThread(id: string, parentStreamId: string, createdBy: string, archived = false) {
    await StreamRepository.insert(pool, {
      id,
      workspaceId: workspace,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PRIVATE,
      parentStreamId,
      parentAnchorId: `msg_${id.slice(-10)}`,
      rootStreamId: ids.A,
      createdBy,
    })
    if (archived) await StreamRepository.update(pool, id, { archivedAt: new Date() })
  }

  function archivedAtByIds() {
    return pool
      .query<{
        id: string
        archived_at: Date | null
      }>("SELECT id, archived_at FROM streams WHERE workspace_id = $1 ORDER BY id", [workspace])
      .then((result) => new Map(result.rows.map((row) => [row.id, row.archived_at !== null])))
  }

  function sealedSubset(candidates: string[]) {
    return StreamRepository.filterEffectivelyArchivedIds(pool, workspace, candidates).then((sealed) =>
      candidates.filter((id) => sealed.includes(id))
    )
  }

  async function rejection(promise: Promise<unknown>): Promise<HttpError> {
    return promise.then(
      () => {
        throw new Error("expected the call to be rejected")
      },
      (error: unknown) => error as HttpError
    )
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new StreamService(pool)
    workspace = workspaceId()
    for (const key of Object.keys(ids) as Array<keyof typeof ids>) ids[key] = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: workspace,
        name: "Archival chain",
        slug: `archival-chain-${workspace}`,
        createdBy: userId(),
      })
      owner = (await addTestMember(client, workspace, userId())).id
      author = (await addTestMember(client, workspace, userId())).id
      bystander = (await addTestMember(client, workspace, userId())).id
      await StreamRepository.insert(client, {
        id: ids.A,
        workspaceId: workspace,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        slug: `chain-${ids.A.slice(-10)}`,
        createdBy: owner,
      })
      await StreamMemberRepository.insertMany(client, ids.A, [owner, author, bystander])
    })
  }, 30_000)

  beforeEach(async () => {
    await pool.query("DELETE FROM user_activity WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM bot_runtime_session_links WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM outbox WHERE payload->>'workspaceId' = $1", [workspace])
    await pool.query("DELETE FROM stream_events WHERE stream_id IN (SELECT id FROM streams WHERE workspace_id = $1)", [
      workspace,
    ])
    await pool.query("DELETE FROM streams WHERE workspace_id = $1 AND id <> $2", [workspace, ids.A])
    await pool.query("UPDATE streams SET archived_at = NULL WHERE id = $1", [ids.A])
    await insertThread(ids.B, ids.A, author)
    await insertThread(ids.C, ids.B, author)
    await insertThread(ids.D, ids.C, owner)
    await insertThread(ids.E, ids.A, author)
    await insertThread(ids.F, ids.A, author, true)
    await insertThread(ids.G, ids.F, author)
  })

  afterAll(async () => {
    await pool.query("DELETE FROM user_activity WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM bot_runtime_session_links WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM outbox WHERE payload->>'workspaceId' = $1", [workspace])
    await pool.query("DELETE FROM stream_members WHERE stream_id = $1", [ids.A])
    await pool.query("DELETE FROM streams WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM users WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspace])
    await pool.end()
  })

  test("archiving a mid-chain thread seals every descendant on read and writes only its own row", async () => {
    const archived = await service.archiveStream(ids.B, workspace, author)
    const all = [ids.A, ids.B, ids.C, ids.D, ids.E, ids.F, ids.G]

    expect({
      archivedId: archived?.id,
      ownFlags: [...(await archivedAtByIds()).entries()]
        .filter(([, flag]) => flag)
        .map(([id]) => id)
        .sort(),
      sealed: await sealedSubset(all),
      active: (await StreamRepository.filterEffectivelyActiveIds(pool, workspace, all)).sort(),
      nearest: {
        B: await StreamRepository.findNearestArchivedAncestor(pool, workspace, ids.B),
        D: (await StreamRepository.findNearestArchivedAncestor(pool, workspace, ids.D))?.streamId,
        E: await StreamRepository.findNearestArchivedAncestor(pool, workspace, ids.E),
        G: (await StreamRepository.findNearestArchivedAncestor(pool, workspace, ids.G))?.streamId,
      },
    }).toEqual({
      archivedId: ids.B,
      ownFlags: [ids.B, ids.F].sort(),
      sealed: [ids.B, ids.C, ids.D, ids.F, ids.G],
      active: [ids.A, ids.E].sort(),
      nearest: { B: null, D: ids.B, E: null, G: ids.F },
    })
  })

  test("the outbox cascade covers live descendants only and stops at an own-archived branch", async () => {
    expect({
      fromRoot: (await StreamRepository.listArchivalCascadeIds(pool, workspace, ids.A)).sort(),
      fromB: (await StreamRepository.listArchivalCascadeIds(pool, workspace, ids.B)).sort(),
      fromLeaf: await StreamRepository.listArchivalCascadeIds(pool, workspace, ids.D),
    }).toEqual({
      fromRoot: [ids.B, ids.C, ids.D, ids.E].sort(),
      fromB: [ids.C, ids.D].sort(),
      fromLeaf: [],
    })

    await service.archiveStream(ids.B, workspace, author)
    const outbox = await pool.query<{ event_type: string; payload: { streamId: string; threadStreamIds: string[] } }>(
      "SELECT event_type, payload FROM outbox WHERE event_type = 'stream:archived' AND payload->>'streamId' = $1",
      [ids.B]
    )
    expect(
      outbox.rows.map((row) => ({
        ...row,
        payload: { ...row.payload, threadStreamIds: row.payload.threadStreamIds.sort() },
      }))
    ).toMatchObject([
      { event_type: "stream:archived", payload: { streamId: ids.B, threadStreamIds: [ids.C, ids.D].sort() } },
    ])
  })

  test("write authority locks the whole chain and refuses a leaf under an archived ancestor", async () => {
    await service.archiveStream(ids.B, workspace, author)

    const facts = await withTransaction(pool, (client) => lockEffectiveStreams(client, workspace, [ids.D, ids.E]))
    expect(
      facts.map(({ target, root, ancestorArchived }) => ({ id: target.id, root: root.id, ancestorArchived }))
    ).toEqual([ids.D, ids.E].sort().map((id) => ({ id, root: ids.A, ancestorArchived: id === ids.D })))

    const denied = await rejection(
      withTransaction(pool, (client) =>
        assertStreamWritable(client, {
          workspaceId: workspace,
          streamId: ids.D,
          principal: { kind: "user", userId: author },
        })
      )
    )
    const allowed = await withTransaction(pool, (client) =>
      assertStreamWritable(client, {
        workspaceId: workspace,
        streamId: ids.E,
        principal: { kind: "user", userId: author },
      })
    )
    expect({
      denied: { status: denied.status, code: denied.code, details: denied.details },
      allowed: allowed.state,
    }).toEqual({
      denied: { status: 403, code: "STREAM_READ_ONLY", details: { reason: "archived" } },
      allowed: { readOnly: false, readOnlyReason: null },
    })
  })

  test("lists hide sealed descendants, the archived list shows what was archived, includeArchived shows all", async () => {
    await service.archiveStream(ids.B, workspace, author)
    const pick = (streams: Array<{ id: string }>) => streams.map(({ id }) => id).sort()

    expect({
      active: pick(await StreamRepository.list(pool, workspace, { userMembershipStreamIds: [ids.A] })),
      activeThreads: pick(
        await StreamRepository.list(pool, workspace, { userMembershipStreamIds: [ids.A], types: [StreamTypes.THREAD] })
      ),
      childrenOfA: pick(await StreamRepository.list(pool, workspace, { parentStreamId: ids.A })),
      archived: pick(await StreamRepository.list(pool, workspace, { archiveStatus: ["archived"] })),
      both: pick(await StreamRepository.list(pool, workspace, { archiveStatus: ["active", "archived"] })),
      byIds: pick(await StreamRepository.listByIds(pool, workspace, [ids.B, ids.C, ids.D, ids.E, ids.G])),
      byIdsIncludingArchived: pick(
        await StreamRepository.listByIds(pool, workspace, [ids.B, ids.C, ids.D, ids.E, ids.G], {
          includeArchived: true,
        })
      ),
      previews: pick(await StreamRepository.listWithPreviews(pool, workspace, { userMembershipStreamIds: [ids.A] })),
      archivedForMember: pick(await service.listArchivedStreams(workspace, bystander)),
    }).toEqual({
      active: [ids.A, ids.E].sort(),
      activeThreads: [ids.E],
      childrenOfA: [ids.E],
      archived: [ids.B, ids.F].sort(),
      both: [ids.A, ids.B, ids.C, ids.D, ids.E, ids.F, ids.G].sort(),
      byIds: [ids.E],
      byIdsIncludingArchived: [ids.B, ids.C, ids.D, ids.E, ids.G].sort(),
      previews: [ids.A, ids.E].sort(),
      archivedForMember: [ids.B, ids.F].sort(),
    })
  })

  test("the activity feed and unread counts skip rows in sealed streams and readmit them on unarchive", async () => {
    const insertActivity = (streamId: string, activityType: string) =>
      ActivityRepository.insert(pool, {
        workspaceId: workspace,
        userId: owner,
        activityType,
        streamId,
        messageId: `msg_${streamId.slice(-10)}`,
        actorId: author,
        actorType: "user",
      })
    const inD = await insertActivity(ids.D, ActivityTypes.MENTION)
    const inE = await insertActivity(ids.E, ActivityTypes.MESSAGE)
    const inG = await insertActivity(ids.G, ActivityTypes.MENTION)
    const feedIds = () =>
      ActivityRepository.listByUser(pool, owner, workspace).then((rows) => rows.map(({ id }) => id).sort())
    const countedStreams = () =>
      ActivityRepository.countUnreadGrouped(pool, owner, workspace).then((counts) => ({
        streams: [...counts.totalByStream.keys()].sort(),
        mentions: [...counts.mentionsByStream.keys()].sort(),
        total: counts.total,
      }))

    expect({ feed: await feedIds(), counts: await countedStreams() }).toEqual({
      feed: [inD!.id, inE!.id].sort(),
      counts: { streams: [ids.D, ids.E].sort(), mentions: [ids.D], total: 2 },
    })

    await service.archiveStream(ids.B, workspace, author)
    expect({ feed: await feedIds(), counts: await countedStreams() }).toEqual({
      feed: [inE!.id],
      counts: { streams: [ids.E], mentions: [], total: 1 },
    })

    await service.unarchiveStream(ids.B, workspace, author)
    expect(await feedIds()).toEqual([inD!.id, inE!.id].sort())
    expect(inG).not.toBeNull()
  })

  test("archive and unarchive are open to the thread creator and the root creator, nobody else", async () => {
    const forbidden = await rejection(service.archiveStream(ids.E, workspace, bystander))
    const byRootCreator = await service.archiveStream(ids.E, workspace, owner)
    const unarchiveForbidden = await rejection(service.unarchiveStream(ids.E, workspace, bystander))
    const byThreadCreator = await service.unarchiveStream(ids.E, workspace, author)

    expect({
      forbidden: { status: forbidden.status, code: forbidden.code },
      byRootCreator: byRootCreator?.archivedAt !== null,
      unarchiveForbidden: { status: unarchiveForbidden.status, code: unarchiveForbidden.code },
      byThreadCreator: byThreadCreator?.archivedAt,
    }).toEqual({
      forbidden: { status: 403, code: "FORBIDDEN" },
      byRootCreator: true,
      unarchiveForbidden: { status: 403, code: "FORBIDDEN" },
      byThreadCreator: null,
    })
  })

  test("unarchiving a thread under an archived root clears its row but leaves the subtree sealed by the root", async () => {
    await service.archiveStream(ids.B, workspace, author)
    await service.archiveStream(ids.A, workspace, owner)
    const revived = await service.unarchiveStream(ids.B, workspace, author)

    expect({
      ownFlag: revived?.archivedAt,
      sealed: await sealedSubset([ids.A, ids.B, ids.C, ids.D, ids.E]),
      sealedBy: (await service.findArchivedAncestor(workspace, ids.D))?.streamId,
    }).toEqual({ ownFlag: null, sealed: [ids.A, ids.B, ids.C, ids.D, ids.E], sealedBy: ids.A })

    await service.unarchiveStream(ids.A, workspace, owner)
    expect(await sealedSubset([ids.A, ids.B, ids.C, ids.D, ids.E, ids.F, ids.G])).toEqual([ids.F, ids.G])
  })

  test("runtime session links end with the cascade and revive only once the chain is clear", async () => {
    const link = (activeStreamId: string, runtimeSessionId: string) =>
      BotRuntimeSessionLinkRepository.upsert(pool, {
        id: botRuntimeSessionLinkId(),
        workspaceId: workspace,
        botId: "bot_chain",
        runtimeKind: "pi-local",
        instanceId: "inst_chain",
        runtimeSessionId,
        rootStreamId: ids.A,
        activeStreamId,
        linkedBy: owner,
      })
    await link(ids.D, "sess_d")
    await link(ids.E, "sess_e")
    const statuses = async () =>
      Object.fromEntries(
        (
          await pool.query<{ active_stream_id: string; status: string }>(
            "SELECT active_stream_id, status FROM bot_runtime_session_links WHERE workspace_id = $1",
            [workspace]
          )
        ).rows.map((row) => [row.active_stream_id === ids.D ? "D" : "E", row.status])
      )
    const reattach = (runtimeSessionId: string) =>
      BotRuntimeSessionLinkRepository.reactivateArchivedByRuntimeSession(pool, {
        workspaceId: workspace,
        botId: "bot_chain",
        runtimeKind: "pi-local",
        instanceId: "inst_chain",
        runtimeSessionId,
      })

    await service.archiveStream(ids.B, workspace, author)
    const cascade = [ids.B, ...(await StreamRepository.listArchivalCascadeIds(pool, workspace, ids.B))]
    await BotRuntimeSessionLinkRepository.archiveActiveByStreams(pool, { workspaceId: workspace, streamIds: cascade })
    const afterArchive = await statuses()
    const reattachWhileSealed = await reattach("sess_d")

    await service.unarchiveStream(ids.B, workspace, author)
    const reattachAfterRelease = await reattach("sess_d")

    expect({
      afterArchive,
      reattachWhileSealed,
      reattachAfterRelease: reattachAfterRelease?.status,
      final: await statuses(),
    }).toEqual({
      afterArchive: { D: "archived", E: "active" },
      reattachWhileSealed: null,
      reattachAfterRelease: "active",
      final: { D: "active", E: "active" },
    })
  })
})
