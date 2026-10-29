import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { DocErrorCodes, StreamErrorCodes, type Stream } from "@threahq/types"
import { StreamRepository, StreamService, checkStreamAccess, listAccessibleStreamIds } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging/event-service"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { userId, workspaceId } from "../../src/lib/id"
import { addTestMember, refusal, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streams: StreamService
let events: EventService
let wsId: string
let owner: string
let member: string
let outsider: string
let slug = 0

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("docs-nesting")
  pool = db.pool
  cleanup = db.cleanup
  streams = new StreamService(pool)
  events = new EventService(pool)
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    member = (await addTestMember(client, wsId, userId())).id
    outsider = (await addTestMember(client, wsId, userId())).id
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Docs Nesting Test Workspace",
      slug: `docs-nesting-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => cleanup())

function channel(visibility: "private" | "public", memberIds: string[] = []): Promise<Stream> {
  return streams.createChannel({
    workspaceId: wsId,
    slug: `docs-nesting-${++slug}`,
    visibility,
    createdBy: owner,
    memberIds,
  })
}

function createHostedDoc(parentStreamId: string, createdBy = owner) {
  return streams.create({ workspaceId: wsId, type: "doc", parentStreamId, createdBy })
}

describe("nested docs", () => {
  test("should create under a standalone doc and inherit its root access for read and write", async () => {
    const root = await streams.create({ workspaceId: wsId, type: "doc", createdBy: owner })
    const child = await createHostedDoc(root.id)
    const grandchild = await createHostedDoc(child.id)

    expect({
      child: { parent: child.parentStreamId, root: child.rootStreamId, visibility: child.visibility },
      grandchild: { parent: grandchild.parentStreamId, root: grandchild.rootStreamId },
      memberCanRead: (await checkStreamAccess(pool, grandchild.id, wsId, member))?.id ?? null,
      outsiderCanRead: (await checkStreamAccess(pool, grandchild.id, wsId, outsider))?.id ?? null,
    }).toEqual({
      child: { parent: root.id, root: root.id, visibility: "private" },
      grandchild: { parent: child.id, root: root.id },
      memberCanRead: null,
      outsiderCanRead: null,
    })
  })

  test("should allow a channel member to create a child doc but keep doc bodies message-readonly", async () => {
    const host = await channel("private", [member])
    const parent = await createHostedDoc(host.id)
    const child = await createHostedDoc(parent.id, member)
    const messageAttempt = refusal(
      events.createMessageForPrincipalReturningConversation(
        { kind: "user", userId: member },
        {
          workspaceId: wsId,
          streamId: child.id,
          authorId: member,
          authorType: "user",
          contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "message" }] }] },
          contentMarkdown: "message",
        }
      )
    )

    expect({
      parent: child.parentStreamId,
      root: child.rootStreamId,
      memberReads: (await checkStreamAccess(pool, child.id, wsId, member))?.id ?? null,
      outsiderReads: (await checkStreamAccess(pool, child.id, wsId, outsider))?.id ?? null,
      message: await messageAttempt,
    }).toEqual({
      parent: parent.id,
      root: host.id,
      memberReads: child.id,
      outsiderReads: null,
      message: { status: 403, code: StreamErrorCodes.READ_ONLY },
    })
  })

  test("should let nonmembers read a public hosted doc without granting them child creation", async () => {
    const host = await channel("public")
    const parent = await createHostedDoc(host.id)

    expect({
      readable: (await checkStreamAccess(pool, parent.id, wsId, outsider))?.id ?? null,
      listed: [...(await listAccessibleStreamIds(pool, wsId, outsider, [parent.id]))],
      create: await refusal(createHostedDoc(parent.id, outsider)),
    }).toEqual({
      readable: parent.id,
      listed: [parent.id],
      create: { status: 403, code: StreamErrorCodes.READ_ONLY },
    })
  })

  test("should refuse a nested doc below an archived doc ancestor without inserting it", async () => {
    const parent = await streams.create({ workspaceId: wsId, type: "doc", createdBy: owner })
    const child = await createHostedDoc(parent.id)
    await streams.archiveStream(parent.id, wsId, owner)
    const childrenBefore = await pool.query<{ id: string }>(
      "SELECT id FROM streams WHERE workspace_id = $1 AND parent_stream_id = $2 AND type = 'doc' ORDER BY id",
      [wsId, child.id]
    )
    const refusalResult = await refusal(createHostedDoc(child.id))
    const childrenAfter = await pool.query<{ id: string }>(
      "SELECT id FROM streams WHERE workspace_id = $1 AND parent_stream_id = $2 AND type = 'doc' ORDER BY id",
      [wsId, child.id]
    )

    expect({
      refusal: refusalResult,
      childParent: (await streams.getStreamById(wsId, child.id))?.parentStreamId,
      childrenBefore: childrenBefore.rows,
      childrenAfter: childrenAfter.rows,
    }).toEqual({
      refusal: { status: 403, code: StreamErrorCodes.READ_ONLY },
      childParent: parent.id,
      childrenBefore: [],
      childrenAfter: [],
    })
  })

  test("should refuse self and deep-descendant moves without changing placement or events", async () => {
    const root = await streams.create({ workspaceId: wsId, type: "doc", createdBy: owner })
    const child = await createHostedDoc(root.id)
    const grandchild = await createHostedDoc(child.id)
    const placement = () =>
      Promise.all(
        [root, child, grandchild].map(async (stream) => {
          const current = await streams.getStreamById(wsId, stream.id)
          return { id: current?.id, parentStreamId: current?.parentStreamId, rootStreamId: current?.rootStreamId }
        })
      )

    const originalPlacement = await placement()
    const originalEvents = await pool.query<{ count: string }>(
      `SELECT count(*) FROM stream_events WHERE workspace_id = $1 AND event_type = 'doc:moved'`,
      [wsId]
    )
    const self = await refusal(
      streams.moveDoc({
        workspaceId: wsId,
        docId: root.id,
        fromStreamId: null,
        toStreamId: root.id,
        principal: { kind: "user", userId: owner },
        isWorkspaceAdmin: false,
      })
    )
    const descendant = await refusal(
      streams.moveDoc({
        workspaceId: wsId,
        docId: root.id,
        fromStreamId: null,
        toStreamId: grandchild.id,
        principal: { kind: "user", userId: owner },
        isWorkspaceAdmin: false,
      })
    )
    const previewDescendant = await refusal(
      streams.previewDocMove({ workspaceId: wsId, docId: root.id, toStreamId: grandchild.id, userId: owner })
    )
    const finalEvents = await pool.query<{ count: string }>(
      `SELECT count(*) FROM stream_events WHERE workspace_id = $1 AND event_type = 'doc:moved'`,
      [wsId]
    )

    expect({
      self,
      descendant,
      previewDescendant,
      placement: await placement(),
      eventCount: finalEvents.rows[0]?.count,
    }).toEqual({
      self: { status: 400, code: DocErrorCodes.MOVE_CYCLE },
      descendant: { status: 400, code: DocErrorCodes.MOVE_CYCLE },
      previewDescendant: { status: 400, code: DocErrorCodes.MOVE_CYCLE },
      placement: originalPlacement,
      eventCount: originalEvents.rows[0]?.count,
    })
  })

  test("should settle reciprocal root-doc moves with one placement and one cycle refusal", async () => {
    const left = await streams.create({ workspaceId: wsId, type: "doc", createdBy: owner })
    const right = await streams.create({ workspaceId: wsId, type: "doc", createdBy: owner })
    const move = (docId: string, toStreamId: string) =>
      streams.moveDoc({
        workspaceId: wsId,
        docId,
        fromStreamId: null,
        toStreamId,
        principal: { kind: "user", userId: owner },
        isWorkspaceAdmin: false,
      })

    const results = await Promise.all([refusal(move(left.id, right.id)), refusal(move(right.id, left.id))])
    const [leftAfter, rightAfter] = await Promise.all([
      streams.getStreamById(wsId, left.id),
      streams.getStreamById(wsId, right.id),
    ])
    const winnerIsAcyclic = !(leftAfter?.parentStreamId === right.id && rightAfter?.parentStreamId === left.id)
    const rootsMatchWinner =
      (leftAfter?.parentStreamId === right.id &&
        leftAfter.rootStreamId === right.id &&
        rightAfter?.rootStreamId === null) ||
      (rightAfter?.parentStreamId === left.id &&
        rightAfter.rootStreamId === left.id &&
        leftAfter?.rootStreamId === null)

    expect({
      failures: results.filter((result) => result !== null),
      winnerIsAcyclic,
      rootsMatchWinner,
    }).toEqual({
      failures: [{ status: 400, code: DocErrorCodes.MOVE_CYCLE }],
      winnerIsAcyclic: true,
      rootsMatchWinner: true,
    })
  })

  test("should allow moving a doc under a former descendant that moved out before the locked refresh", async () => {
    const root = await streams.create({ workspaceId: wsId, type: "doc", createdBy: owner })
    const child = await createHostedDoc(root.id)
    const listSubtreeIds = StreamRepository.listDocSubtreeIds.bind(StreamRepository)
    let movedChildOut = false
    const listSpy = spyOn(StreamRepository, "listDocSubtreeIds").mockImplementation(async (...args) => {
      const ids = await listSubtreeIds(...args)
      if (!movedChildOut) {
        movedChildOut = true
        await streams.moveDoc({
          workspaceId: wsId,
          docId: child.id,
          fromStreamId: root.id,
          toStreamId: null,
          principal: { kind: "user", userId: owner },
          isWorkspaceAdmin: false,
        })
      }
      return ids
    })

    try {
      const moved = await streams.moveDoc({
        workspaceId: wsId,
        docId: root.id,
        fromStreamId: null,
        toStreamId: child.id,
        principal: { kind: "user", userId: owner },
        isWorkspaceAdmin: false,
      })
      const childAfter = await streams.getStreamById(wsId, child.id)

      expect({
        rootParent: moved.parentStreamId,
        rootRoot: moved.rootStreamId,
        childParent: childAfter?.parentStreamId,
        childRoot: childAfter?.rootStreamId,
      }).toEqual({
        rootParent: child.id,
        rootRoot: child.id,
        childParent: null,
        childRoot: null,
      })
    } finally {
      listSpy.mockRestore()
    }
  })
})
