/**
 * The guest DM policy against the real server and schema: a DM with a guest is created only when the
 * workspace policy allows that pair, and tightening the policy closes DMs that already exist for every
 * writer, not only the HTTP send path. Guests are seeded by flipping `users.role`, since guests are
 * not invitable yet.
 *
 * Run: bun test --preload ./tests/setup.ts tests/integration/guest-dm-policy.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { GUEST_DM_POLICIES, type GuestDmPolicy } from "@threahq/types"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import {
  StreamRepository,
  StreamService,
  assertStreamWritable,
  projectStreamForPrincipal,
  projectStreamsForPrincipal,
} from "../../src/features/streams"
import { botId as newBotId, botChannelAccessId } from "../../src/lib/id"
import { getTestDatabaseTarget } from "../test-database"
import {
  TestClient,
  createChannel,
  createThread,
  createWorkspace,
  getUserId,
  joinWorkspace,
  listEvents,
  loginAs,
  type Message,
} from "../client"

const runId = Math.random().toString(36).slice(2, 8)
let personCount = 0

interface Person {
  client: TestClient
  userId: string
}

type PersonRole = "member" | "admin" | "guest"

interface SendOutcome {
  status: number
  code?: string
  reason?: string
  message?: Message
}

const SENT = { status: 201 }
const CLOSED = { status: 403, code: "STREAM_READ_ONLY", reason: "guest_dm_policy" }

describe("guest DM policy", () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
  })

  afterAll(async () => {
    await pool.end()
  })

  /** A guest only sees, and so can only target, people it shares a stream with, so everyone joins one private channel. */
  async function newWorkspace() {
    personCount += 1
    const ownerClient = new TestClient()
    const ownerUser = await loginAs(ownerClient, `owner-${personCount}-${runId}@test.com`, "Owner")
    const workspace = await createWorkspace(ownerClient, `Guest DM policy ${runId}`)
    const workspaceId = workspace.id
    const sharedStream = await createChannel(ownerClient, workspaceId, `shared-${personCount}-${runId}`)

    async function add(role: PersonRole): Promise<Person> {
      personCount += 1
      const client = new TestClient()
      const user = await loginAs(client, `${role}-${personCount}-${runId}@test.com`, `Person ${personCount}`)
      await joinWorkspace(client, workspaceId, role === "guest" ? "member" : role)
      const userId = await getUserId(client, workspaceId, user.id)
      if (role === "guest") {
        await pool.query("UPDATE users SET role = 'guest' WHERE workspace_id = $1 AND id = $2", [workspaceId, userId])
      }
      await pool.query("INSERT INTO stream_members (workspace_id, stream_id, member_id) VALUES ($1, $2, $3)", [
        workspaceId,
        sharedStream.id,
        userId,
      ])
      return { client, userId }
    }

    const owner: Person = { client: ownerClient, userId: await getUserId(ownerClient, workspaceId, ownerUser.id) }
    return { workspaceId, owner, add, sharedStreamId: sharedStream.id }
  }

  async function setPolicy(workspaceId: string, owner: Person, policy: GuestDmPolicy) {
    const { status } = await owner.client.patch(`/api/workspaces/${workspaceId}/workspace-settings`, {
      guestDmPolicy: policy,
    })
    expect(status).toBe(200)
  }

  async function send(
    workspaceId: string,
    from: Person,
    target: { dmUserId: string } | { streamId: string },
    content: string
  ): Promise<SendOutcome> {
    const { status, data } = await from.client.post<{
      message?: Message
      code?: string
      details?: { reason?: string }
    }>(`/api/workspaces/${workspaceId}/messages`, { ...target, content })
    return status === 201
      ? { status, message: data.message }
      : { status, code: data.code, reason: data.details?.reason }
  }

  const outcomeOf = ({ message: _message, ...outcome }: SendOutcome) => outcome

  async function dmCount(workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM streams WHERE workspace_id = $1 AND type = 'dm'",
      [workspaceId]
    )
    return Number(rows[0].count)
  }

  test("should refuse a DM between a guest and a member when the policy is the default off", async () => {
    const { workspaceId, owner, add } = await newWorkspace()
    const guest = await add("guest")
    const member = await add("member")

    const outcomes = {
      guestToMember: outcomeOf(await send(workspaceId, guest, { dmUserId: member.userId }, "hi")),
      memberToGuest: outcomeOf(await send(workspaceId, member, { dmUserId: guest.userId }, "hi")),
      guestToOwner: outcomeOf(await send(workspaceId, guest, { dmUserId: owner.userId }, "hi")),
    }
    expect({ outcomes, dms: await dmCount(workspaceId) }).toEqual({
      outcomes: { guestToMember: CLOSED, memberToGuest: CLOSED, guestToOwner: CLOSED },
      dms: 0,
    })

    expect(outcomeOf(await send(workspaceId, member, { dmUserId: owner.userId }, "hi"))).toEqual(SENT)
    expect(await dmCount(workspaceId)).toBe(1)
  })

  test("should open only guest-to-admin DMs when the policy is admins", async () => {
    const { workspaceId, owner, add } = await newWorkspace()
    await setPolicy(workspaceId, owner, GUEST_DM_POLICIES.ADMINS)
    const guest = await add("guest")
    const otherGuest = await add("guest")
    const member = await add("member")
    const admin = await add("admin")

    const outcomes = {
      guestToMember: outcomeOf(await send(workspaceId, guest, { dmUserId: member.userId }, "hi")),
      memberToGuest: outcomeOf(await send(workspaceId, member, { dmUserId: guest.userId }, "hi")),
      guestToGuest: outcomeOf(await send(workspaceId, guest, { dmUserId: otherGuest.userId }, "hi")),
      guestToAdmin: outcomeOf(await send(workspaceId, guest, { dmUserId: admin.userId }, "hi")),
      guestToOwner: outcomeOf(await send(workspaceId, guest, { dmUserId: owner.userId }, "hi")),
    }
    expect({ outcomes, dms: await dmCount(workspaceId) }).toEqual({
      outcomes: {
        guestToMember: CLOSED,
        memberToGuest: CLOSED,
        guestToGuest: CLOSED,
        guestToAdmin: SENT,
        guestToOwner: SENT,
      },
      dms: 2,
    })
  })

  test("should open a DM between a guest and a member when the policy is open", async () => {
    const { workspaceId, owner, add } = await newWorkspace()
    await setPolicy(workspaceId, owner, GUEST_DM_POLICIES.OPEN)
    const guest = await add("guest")
    const member = await add("member")

    const first = await send(workspaceId, guest, { dmUserId: member.userId }, "hi member")
    expect(outcomeOf(first)).toEqual(SENT)
    const reply = await send(workspaceId, member, { streamId: first.message!.streamId }, "hi guest")
    expect(outcomeOf(reply)).toEqual(SENT)
  })

  test("should close an existing DM to every writer when the policy tightens and reopen it when it loosens", async () => {
    const { workspaceId, owner, add, sharedStreamId } = await newWorkspace()
    await setPolicy(workspaceId, owner, GUEST_DM_POLICIES.OPEN)
    const guest = await add("guest")
    const member = await add("member")

    const first = await send(workspaceId, guest, { dmUserId: member.userId }, "before")
    expect(outcomeOf(first)).toEqual(SENT)
    const dmStreamId = first.message!.streamId

    const botId = newBotId()
    await pool.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1, $2, $3, 'DM bot')", [
      botId,
      workspaceId,
      `key_${botId}`,
    ])
    await BotChannelAccessRepository.grantAccess(pool, {
      id: botChannelAccessId(),
      workspaceId,
      botId,
      streamId: dmStreamId,
      grantedBy: owner.userId,
    })
    const botWrite = () =>
      assertStreamWritable(pool, { workspaceId, streamId: dmStreamId, principal: { kind: "bot", botId } }).then(
        () => "writable",
        (error: { status: number; code: string; details: unknown }) => ({
          status: error.status,
          code: error.code,
          details: error.details,
        })
      )
    expect(await botWrite()).toBe("writable")

    await setPolicy(workspaceId, owner, GUEST_DM_POLICIES.OFF)

    const closed = {
      guestByStream: outcomeOf(await send(workspaceId, guest, { streamId: dmStreamId }, "after")),
      memberByStream: outcomeOf(await send(workspaceId, member, { streamId: dmStreamId }, "after")),
      memberByUser: outcomeOf(await send(workspaceId, member, { dmUserId: guest.userId }, "after")),
      bot: await botWrite(),
    }
    expect(closed).toEqual({
      guestByStream: CLOSED,
      memberByStream: CLOSED,
      memberByUser: CLOSED,
      bot: { status: 403, code: "STREAM_READ_ONLY", details: { reason: "guest_dm_policy" } },
    })

    const memberDm = await send(workspaceId, member, { dmUserId: owner.userId }, "no guest here")
    expect(outcomeOf(memberDm)).toEqual(SENT)
    const streams = await StreamRepository.findByIds(pool, workspaceId, [
      dmStreamId,
      memberDm.message!.streamId,
      sharedStreamId,
    ])
    const byId = Object.fromEntries(streams.map((stream) => [stream.id, stream]))
    const principal = { kind: "user", userId: member.userId } as const
    const viewOf = (stream?: { readOnly: boolean; readOnlyReason: string | null } | null) =>
      stream && { readOnly: stream.readOnly, readOnlyReason: stream.readOnlyReason }
    const batch = await projectStreamsForPrincipal(pool, { workspaceId, streams, principal })
    const batchById = new Map(batch.map((stream) => [stream.id, stream]))
    const closedView = { readOnly: true, readOnlyReason: "guest_dm_policy" }
    const openView = { readOnly: false, readOnlyReason: null }
    expect({
      one: viewOf(await projectStreamForPrincipal(pool, { workspaceId, stream: byId[dmStreamId], principal })),
      batch: {
        guestDm: viewOf(batchById.get(dmStreamId)),
        memberDm: viewOf(batchById.get(memberDm.message!.streamId)),
        channel: viewOf(batchById.get(sharedStreamId)),
      },
    }).toEqual({ one: closedView, batch: { guestDm: closedView, memberDm: openView, channel: openView } })

    const laterBotId = newBotId()
    await pool.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1, $2, $3, 'Late bot')", [
      laterBotId,
      workspaceId,
      `key_${laterBotId}`,
    ])
    await expect(
      new StreamService(pool).addBotToStream(dmStreamId, laterBotId, workspaceId, member.userId)
    ).rejects.toMatchObject({ status: 403, code: "STREAM_READ_ONLY", details: { reason: "guest_dm_policy" } })

    const events = await listEvents(member.client, workspaceId, dmStreamId)
    expect(events.map((event) => (event.payload as { messageId?: string }).messageId)).toContain(first.message!.id)

    await setPolicy(workspaceId, owner, GUEST_DM_POLICIES.OPEN)
    expect(outcomeOf(await send(workspaceId, member, { streamId: dmStreamId }, "again"))).toEqual(SENT)
    expect(await botWrite()).toBe("writable")
  })

  test("should close a guest's DM under admins when the other party was removed from the workspace", async () => {
    const { workspaceId, owner, add } = await newWorkspace()
    await setPolicy(workspaceId, owner, GUEST_DM_POLICIES.OPEN)
    const guest = await add("guest")
    const member = await add("member")

    const first = await send(workspaceId, guest, { dmUserId: member.userId }, "before")
    expect(outcomeOf(first)).toEqual(SENT)
    await pool.query("DELETE FROM users WHERE workspace_id = $1 AND id = $2", [workspaceId, member.userId])
    await setPolicy(workspaceId, owner, GUEST_DM_POLICIES.ADMINS)

    expect(outcomeOf(await send(workspaceId, guest, { streamId: first.message!.streamId }, "after"))).toEqual(CLOSED)
  })

  test("should close a thread under a guest DM through its root when the policy tightens", async () => {
    const { workspaceId, owner, add } = await newWorkspace()
    await setPolicy(workspaceId, owner, GUEST_DM_POLICIES.OPEN)
    const guest = await add("guest")
    const member = await add("member")

    const first = await send(workspaceId, guest, { dmUserId: member.userId }, "root")
    expect(outcomeOf(first)).toEqual(SENT)
    const thread = await createThread(member.client, workspaceId, first.message!.streamId, first.message!.id)
    const inThread = await send(workspaceId, guest, { streamId: thread.id }, "in thread")
    expect(outcomeOf(inThread)).toEqual(SENT)

    await setPolicy(workspaceId, owner, GUEST_DM_POLICIES.OFF)

    const lockedWrite = await assertStreamWritable(pool, {
      workspaceId,
      streamId: thread.id,
      principal: { kind: "user", userId: member.userId },
    }).then(
      () => "writable",
      (error: { status: number; code: string; details: unknown }) => ({
        status: error.status,
        code: error.code,
        details: error.details,
      })
    )
    expect({
      guest: outcomeOf(await send(workspaceId, guest, { streamId: thread.id }, "after")),
      member: outcomeOf(await send(workspaceId, member, { streamId: thread.id }, "after")),
      lockedWrite,
    }).toEqual({
      guest: CLOSED,
      member: CLOSED,
      lockedWrite: { status: 403, code: "STREAM_READ_ONLY", details: { reason: "guest_dm_policy" } },
    })

    const events = await listEvents(guest.client, workspaceId, thread.id)
    expect(events.map((event) => (event.payload as { messageId?: string }).messageId)).toContain(inThread.message!.id)
  })

  test("should leave a DM without a guest writable when the policy is off", async () => {
    const { workspaceId, owner, add } = await newWorkspace()
    const member = await add("member")
    const admin = await add("admin")

    const first = await send(workspaceId, member, { dmUserId: admin.userId }, "hello")
    expect(outcomeOf(first)).toEqual(SENT)
    const reply = await send(workspaceId, admin, { streamId: first.message!.streamId }, "hello back")
    expect(outcomeOf(reply)).toEqual(SENT)
    expect(outcomeOf(await send(workspaceId, owner, { dmUserId: member.userId }, "hello"))).toEqual(SENT)
  })
})
