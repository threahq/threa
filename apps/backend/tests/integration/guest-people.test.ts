/**
 * A viewer without browse sees themselves plus the members and authors of the streams they read; a
 * room viewer sees everyone when no reader of the room lacks browse, else the members and authors
 * of what every reader of the room reads; a viewer with browse sees everyone.
 *
 * m8 authored in a thread under `priv` without being a member, m5 authored only a deleted message in
 * `gp`, and loner is a guest with no membership. guest2 reads only `priv3`, where m6 writes without
 * being a member, plus the `guest_public` streams. A room another workspace reads (`sharedPub`, shared
 * out actively, and `copy`, a copy of another workspace's channel) sees only its own tree's people;
 * `revokedPub`'s share ended, so it reads like any public room. A second workspace holds rows under the same stream
 * ids that would leak m1 and m6 if a read dropped its workspace pin.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool, QueryConfig } from "pg"
import { Visibilities, type Visibility } from "@threahq/types"
import type { Querier } from "../../src/db"
import {
  PeoplePurposes,
  UserRepository,
  listGuestViewerIds,
  type PeopleScope,
  type PeopleViewer,
} from "../../src/features/workspaces"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { streamConnectionId } from "@threahq/backend-common"
import { setupTestDatabase } from "./setup"

const LABELS = ["owner", "m1", "guest", "guest2", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "loner"] as const
type Label = (typeof LABELS)[number]

const NON_MEMBER_ROLES: Partial<Record<Label, string>> = {
  owner: "owner",
  guest: "guest",
  guest2: "guest",
  loner: "guest",
}
const GUESTS = LABELS.filter((label) => NON_MEMBER_ROLES[label] === "guest")
const EVERYONE = [...LABELS].sort()
const GUEST_READS = ["guest", "m2", "m3", "m4", "m7", "m8", "owner"]
const PRIVATE_ROOM_READS = ["guest", "m2", "m3", "m4", "m8", "owner"]
const GUEST_PUBLIC_READERS = ["m3", "m4"]

interface PlanNode {
  "Parent Relationship"?: string
  "Actual Loops": number
  Plans?: PlanNode[]
}

describe("guest people", () => {
  let pool: Pool
  let wsA: string
  let wsB: string
  const ids = {} as Record<Label, string>
  const streams = {
    pub: streamId(),
    priv: streamId(),
    privThread: streamId(),
    priv2: streamId(),
    privAllBrowse: streamId(),
    pubWithGuest: streamId(),
    gp: streamId(),
    gpThread: streamId(),
    priv3: streamId(),
    sharedPub: streamId(),
    sharedPubThread: streamId(),
    copy: streamId(),
    revokedPub: streamId(),
  }
  let sequence = 0

  const slugsOf = (users: { slug: string }[]) => users.map((user) => user.slug).sort()
  const scopeFor = (viewer: PeopleViewer): PeopleScope => ({ viewer, purpose: PeoplePurposes.VISIBLE })
  const userScope = (label: Label) => scopeFor({ kind: "user", userId: ids[label] })
  const roomScope = (roomStreamId: string) => scopeFor({ kind: "room", roomStreamId })

  async function insertWorkspace(label: string) {
    const id = workspaceId()
    await pool.query(`INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, $2, $3, $4)`, [
      id,
      `Guest people ${label}`,
      `guest-people-${label}-${id}`,
      userId(),
    ])
    return id
  }

  async function insertStream(
    workspace: string,
    stream: {
      id: string
      visibility: Visibility
      rootStreamId?: string
      originWorkspaceId?: string
      members?: Label[]
    }
  ) {
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, parent_stream_id, root_stream_id, origin_workspace_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
      [
        stream.id,
        workspace,
        stream.rootStreamId ? "thread" : "channel",
        stream.visibility,
        stream.rootStreamId ?? null,
        stream.originWorkspaceId ?? null,
        userId(),
      ]
    )
    for (const member of stream.members ?? []) {
      await pool.query(`INSERT INTO stream_members (workspace_id, stream_id, member_id) VALUES ($1, $2, $3)`, [
        workspace,
        stream.id,
        ids[member],
      ])
    }
  }

  async function insertHostConnection(workspace: string, stream: string, state: "active" | "revoked") {
    await pool.query(
      `INSERT INTO stream_connections (workspace_id, id, role, state, stream_id, remote_workspace_id, expires_at, revision)
       VALUES ($1, $2, 'host', $3, $4, $5, NOW() + INTERVAL '1 day', 1)`,
      [workspace, streamConnectionId(), state, stream, workspaceId()]
    )
  }

  async function insertMessage(workspace: string, stream: string, author: Label, deleted = false) {
    sequence += 1
    await pool.query(
      `INSERT INTO messages (id, workspace_id, stream_id, sequence, author_id, author_type, content_markdown, content_json, created_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, 'user', 'hello', '{}', NOW(), CASE WHEN $6::boolean THEN NOW() END)`,
      [messageId(), workspace, stream, sequence, ids[author], deleted]
    )
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    wsA = await insertWorkspace("a")
    wsB = await insertWorkspace("b")

    for (const label of LABELS) {
      ids[label] = userId()
      const role = NON_MEMBER_ROLES[label] ?? "member"
      await pool.query(
        `INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name) VALUES ($1, $2, NULL, NULL, $3, $4, $5)`,
        [ids[label], wsA, role, label, `Person ${label}`]
      )
    }

    await insertStream(wsA, { id: streams.pub, visibility: Visibilities.PUBLIC, members: ["m1"] })
    await insertStream(wsA, { id: streams.priv, visibility: Visibilities.PRIVATE, members: ["guest", "m2", "owner"] })
    await insertStream(wsA, {
      id: streams.privThread,
      visibility: Visibilities.PRIVATE,
      rootStreamId: streams.priv,
    })
    await insertStream(wsA, { id: streams.priv2, visibility: Visibilities.PRIVATE, members: ["guest", "m7"] })
    await insertStream(wsA, { id: streams.privAllBrowse, visibility: Visibilities.PRIVATE, members: ["m1", "m7"] })
    await insertStream(wsA, { id: streams.pubWithGuest, visibility: Visibilities.PUBLIC, members: ["guest"] })
    await insertStream(wsA, { id: streams.gp, visibility: Visibilities.GUEST_PUBLIC, members: ["m3"] })
    await insertStream(wsA, {
      id: streams.gpThread,
      visibility: Visibilities.GUEST_PUBLIC,
      rootStreamId: streams.gp,
    })
    await insertStream(wsA, { id: streams.priv3, visibility: Visibilities.PRIVATE, members: ["guest2", "m1"] })
    await insertMessage(wsA, streams.pub, "m6")
    await insertMessage(wsA, streams.priv3, "m6")
    await insertMessage(wsA, streams.priv, "guest")
    await insertMessage(wsA, streams.privThread, "m8")
    await insertMessage(wsA, streams.pubWithGuest, "m2")
    await insertMessage(wsA, streams.gpThread, "m4")
    await insertMessage(wsA, streams.gp, "m5", true)
    await insertStream(wsA, { id: streams.sharedPub, visibility: Visibilities.PUBLIC, members: ["m2"] })
    await insertStream(wsA, {
      id: streams.sharedPubThread,
      visibility: Visibilities.PUBLIC,
      rootStreamId: streams.sharedPub,
    })
    await insertMessage(wsA, streams.sharedPubThread, "m7")
    await insertHostConnection(wsA, streams.sharedPub, "active")
    await insertStream(wsA, {
      id: streams.copy,
      visibility: Visibilities.PUBLIC,
      originWorkspaceId: wsB,
      members: ["m3"],
    })
    await insertStream(wsA, { id: streams.revokedPub, visibility: Visibilities.PUBLIC, members: ["m1"] })
    await insertHostConnection(wsA, streams.revokedPub, "revoked")

    await insertStream(wsB, { id: streams.priv, visibility: Visibilities.PRIVATE, members: ["m1"] })
    await insertStream(wsB, { id: streams.gp, visibility: Visibilities.GUEST_PUBLIC })
    await insertMessage(wsB, streams.gp, "m6")
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should list only the co-members and authors of the streams a guest reads when the viewer is that guest", async () => {
    expect({
      visible: slugsOf(await UserRepository.listByWorkspace(pool, wsA, userScope("guest"))),
      targetable: slugsOf(
        await UserRepository.listByWorkspace(pool, wsA, { ...userScope("guest"), purpose: PeoplePurposes.TARGETABLE })
      ),
    }).toEqual({ visible: GUEST_READS, targetable: GUEST_READS })
  })

  test("should list the guest and the people of guest_public streams when the guest holds no membership", async () => {
    expect(slugsOf(await UserRepository.listByWorkspace(pool, wsA, userScope("loner")))).toEqual(
      ["loner", ...GUEST_PUBLIC_READERS].sort()
    )
  })

  test("should list everyone when the viewer has browse", async () => {
    expect({
      member: slugsOf(await UserRepository.listByWorkspace(pool, wsA, userScope("m1"))),
      owner: slugsOf(await UserRepository.listByWorkspace(pool, wsA, userScope("owner"))),
    }).toEqual({ member: EVERYONE, owner: EVERYONE })
  })

  test("should drop hidden users from every scoped read when the viewer is a guest", async () => {
    const scope = userScope("guest")
    const allIds = Object.values(ids)

    expect({
      queried: slugsOf(await UserRepository.listByWorkspace(pool, wsA, scope, { query: "Person" })),
      searched: slugsOf(await UserRepository.searchByNameOrSlug(pool, wsA, "Person", 20, scope)),
      bySlugs: slugsOf(await UserRepository.findBySlugs(pool, wsA, [...LABELS], scope)),
      byIds: slugsOf(await UserRepository.findByIds(pool, wsA, allIds, scope)),
      hiddenById: (await UserRepository.findById(pool, wsA, ids.m1, scope))?.slug ?? null,
      visibleById: (await UserRepository.findById(pool, wsA, ids.m2, scope))?.slug ?? null,
      byIdsUnscoped: slugsOf(await UserRepository.findByIds(pool, wsA, allIds)),
    }).toEqual({
      queried: GUEST_READS,
      searched: GUEST_READS,
      bySlugs: GUEST_READS,
      byIds: GUEST_READS,
      hiddenById: null,
      visibleById: "m2",
      byIdsUnscoped: EVERYONE,
    })
  })

  test("should list the people of what every reader reads when the viewer is a room", async () => {
    expect({
      privateRoomWithGuest: slugsOf(await UserRepository.listByWorkspace(pool, wsA, roomScope(streams.priv))),
      threadInPrivateRoomWithGuest: slugsOf(
        await UserRepository.listByWorkspace(pool, wsA, roomScope(streams.privThread))
      ),
      privateRoomWithoutGuest: slugsOf(
        await UserRepository.listByWorkspace(pool, wsA, roomScope(streams.privAllBrowse))
      ),
      publicRoomWithoutGuest: slugsOf(await UserRepository.listByWorkspace(pool, wsA, roomScope(streams.pub))),
      publicRoomWithGuest: slugsOf(await UserRepository.listByWorkspace(pool, wsA, roomScope(streams.pubWithGuest))),
      guestPublicRoom: slugsOf(await UserRepository.listByWorkspace(pool, wsA, roomScope(streams.gp))),
      missingRoom: slugsOf(await UserRepository.listByWorkspace(pool, wsA, roomScope(streamId()))),
      sharedRoom: slugsOf(await UserRepository.listByWorkspace(pool, wsA, roomScope(streams.sharedPub))),
      threadInSharedRoom: slugsOf(await UserRepository.listByWorkspace(pool, wsA, roomScope(streams.sharedPubThread))),
      copyRoom: slugsOf(await UserRepository.listByWorkspace(pool, wsA, roomScope(streams.copy))),
      revokedShareRoom: slugsOf(await UserRepository.listByWorkspace(pool, wsA, roomScope(streams.revokedPub))),
    }).toEqual({
      privateRoomWithGuest: PRIVATE_ROOM_READS,
      threadInPrivateRoomWithGuest: PRIVATE_ROOM_READS,
      privateRoomWithoutGuest: EVERYONE,
      publicRoomWithoutGuest: EVERYONE,
      publicRoomWithGuest: ["guest", "m2", ...GUEST_PUBLIC_READERS].sort(),
      guestPublicRoom: GUEST_PUBLIC_READERS,
      missingRoom: GUEST_PUBLIC_READERS,
      sharedRoom: ["m2", "m7"],
      threadInSharedRoom: ["m2", "m7"],
      copyRoom: ["m3"],
      revokedShareRoom: EVERYONE,
    })
  })

  async function planOf(scope: PeopleScope) {
    let statement: QueryConfig | undefined
    const capture = {
      query: async (config: QueryConfig) => {
        statement = config
        return { rows: [] }
      },
    } as unknown as Querier
    await UserRepository.listByWorkspace(capture, wsA, scope)

    const explained = await pool.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement!.text}`,
      statement!.values
    )
    return explained.rows[0]!["QUERY PLAN"][0].Plan
  }

  function subplansOf(node: PlanNode): PlanNode[] {
    return (node.Plans ?? []).flatMap((child) => [
      ...(child["Parent Relationship"] === "SubPlan" ? [child] : []),
      ...subplansOf(child),
    ])
  }

  test("should not run the people subplans when the viewer has browse", async () => {
    const summarize = (plan: PlanNode) => {
      const subplans = subplansOf(plan)
      return { hasSubplans: subplans.length > 0, anyExecuted: subplans.some((subplan) => subplan["Actual Loops"] > 0) }
    }

    expect({
      member: summarize(await planOf(userScope("m1"))),
      guest: summarize(await planOf(userScope("guest"))),
    }).toEqual({
      member: { hasSubplans: true, anyExecuted: false },
      guest: { hasSubplans: true, anyExecuted: true },
    })
  })

  const labelsOf = (userIds: string[]) => userIds.map((id) => LABELS.find((label) => ids[label] === id) ?? id).sort()
  const guestsOf = async (label: Label) => labelsOf(await listGuestViewerIds(pool, wsA, ids[label]))

  test("should list the guests whose visible people include the person when asked for any user", async () => {
    const visibleToGuests = new Map<Label, Set<string>>()
    for (const guest of GUESTS) {
      const visible = await UserRepository.listByWorkspace(pool, wsA, userScope(guest))
      visibleToGuests.set(guest, new Set(visible.map((user) => user.id)))
    }
    const expected: Record<string, string[]> = {}
    const actual: Record<string, string[]> = {}
    for (const label of LABELS) {
      expected[label] = GUESTS.filter((guest) => guest !== label && visibleToGuests.get(guest)!.has(ids[label])).sort()
      actual[label] = await guestsOf(label)
    }

    expect(actual).toEqual(expected)
  })

  test("should name each guest that reads a stream the person belongs to or wrote in", async () => {
    expect({
      owner: await guestsOf("owner"),
      m1: await guestsOf("m1"),
      m2: await guestsOf("m2"),
      m3: await guestsOf("m3"),
      m4: await guestsOf("m4"),
      m5: await guestsOf("m5"),
      m6: await guestsOf("m6"),
      m7: await guestsOf("m7"),
      m8: await guestsOf("m8"),
      guest: await guestsOf("guest"),
    }).toEqual({
      owner: ["guest"],
      m1: ["guest2"],
      m2: ["guest"],
      m3: ["guest", "guest2", "loner"],
      m4: ["guest", "guest2", "loner"],
      m5: [],
      m6: ["guest2"],
      m7: ["guest"],
      m8: ["guest"],
      guest: [],
    })
  })

  test("should still name the guests of a user once the user row is removed", async () => {
    const leaver = userId()
    const leaverStream = streamId()
    await pool.query(
      `INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name) VALUES ($1, $2, NULL, NULL, 'member', 'leaver', 'Person leaver')`,
      [leaver, wsA]
    )
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', $3, $4)`,
      [leaverStream, wsA, Visibilities.PRIVATE, userId()]
    )
    await pool.query(
      `INSERT INTO stream_members (workspace_id, stream_id, member_id) VALUES ($1, $2, $3), ($1, $2, $4)`,
      [wsA, leaverStream, leaver, ids.guest]
    )

    const before = await listGuestViewerIds(pool, wsA, leaver)
    await UserRepository.remove(pool, wsA, leaver)
    const after = await listGuestViewerIds(pool, wsA, leaver)

    expect({ before, after }).toEqual({ before: [ids.guest], after: [ids.guest] })
  })
})
