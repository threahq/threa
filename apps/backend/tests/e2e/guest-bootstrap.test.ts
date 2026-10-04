import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { WORKSPACE_ROLE_SLUGS, permissionsForRole } from "@threahq/types"
import { createTestPool } from "../integration/setup"
import {
  TestClient,
  addStreamMember,
  createChannel,
  createScratchpad,
  createWorkspace,
  getBaseUrl,
  getWorkspaceBootstrap,
  joinWorkspace,
  loginAs,
  sendMessage,
  type WorkspaceUser,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)

let pool: Pool

beforeAll(() => {
  pool = createTestPool()
})

afterAll(async () => {
  await pool.end()
})

describe("guest workspace bootstrap", () => {
  test("should list only guest_public streams and the guest's own streams when a member becomes a guest", async () => {
    const owner = new TestClient()
    const guestClient = new TestClient()
    await loginAs(owner, `guestboot-owner-${testRunId}@test.com`, "Guest Bootstrap Owner")
    await loginAs(guestClient, `guestboot-guest-${testRunId}@test.com`, "Guest Bootstrap Guest")
    const workspace = await createWorkspace(owner, `Guest Bootstrap WS ${testRunId}`)

    const publicChannel = await createChannel(owner, workspace.id, `gb-public-${testRunId}`, "public")
    const openChannel = await createChannel(owner, workspace.id, `gb-open-${testRunId}`, "public")
    const privateChannel = await createChannel(owner, workspace.id, `gb-private-${testRunId}`, "private")
    const sharedChannel = await createChannel(owner, workspace.id, `gb-shared-${testRunId}`, "private")
    const ownerScratchpad = await createScratchpad(owner, workspace.id)
    await pool.query(`UPDATE streams SET visibility = 'guest_public' WHERE workspace_id = $1 AND id = $2`, [
      workspace.id,
      openChannel.id,
    ])

    const guest = await joinWorkspace(guestClient, workspace.id)
    expect((await addStreamMember(owner, workspace.id, sharedChannel.id, guest.id)).status).toBe(201)
    const guestScratchpad = await createScratchpad(guestClient, workspace.id)

    const fixture = { publicChannel, openChannel, privateChannel, sharedChannel, ownerScratchpad, guestScratchpad }
    const visibleTo = async () => {
      const bootstrap = await getWorkspaceBootstrap(guestClient, workspace.id)
      const ids = new Set(bootstrap.streams.map((stream) => stream.id))
      return {
        fixtures: Object.entries(fixture)
          .filter(([, stream]) => ids.has(stream.id))
          .map(([name]) => name),
        viewerPermissions: bootstrap.viewerPermissions,
      }
    }

    const asMember = await visibleTo()
    await pool.query(`UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2`, [
      workspace.id,
      guest.id,
      WORKSPACE_ROLE_SLUGS.GUEST,
    ])
    const asGuest = await visibleTo()

    expect({ asMember, asGuest }).toEqual({
      asMember: {
        fixtures: ["publicChannel", "openChannel", "sharedChannel", "guestScratchpad"],
        viewerPermissions: permissionsForRole(WORKSPACE_ROLE_SLUGS.MEMBER),
      },
      asGuest: {
        fixtures: ["openChannel", "sharedChannel", "guestScratchpad"],
        viewerPermissions: permissionsForRole(WORKSPACE_ROLE_SLUGS.GUEST),
      },
    })
  })
})

describe("guest people surfaces", () => {
  let workspaceId: string
  let sharedChannelId: string
  let guestClient: TestClient
  let coMemberClient: TestClient
  let userKeys: { guest: string; coMember: string }
  let fixture: Record<"owner" | "guest" | "coMember" | "openMember" | "hiddenMember", WorkspaceUser>

  const labelsOf = (userIds: string[]) => {
    const labelById = new Map(Object.entries(fixture).map(([label, user]) => [user.id, label]))
    return userIds.map((id) => labelById.get(id) ?? id).sort()
  }

  const bootstrapLabels = async (client: TestClient) =>
    labelsOf((await getWorkspaceBootstrap(client, workspaceId)).users.map((user) => user.id))

  const publicApiLabels = async (userKey: string) => {
    const response = await fetch(`${getBaseUrl()}/api/v1/workspaces/${workspaceId}/users`, {
      headers: { Authorization: `Bearer ${userKey}` },
    })
    const body = (await response.json()) as { data: { id: string }[] }
    if (response.status !== 200) throw new Error(`List users failed (${response.status}): ${JSON.stringify(body)}`)
    return labelsOf(body.data.map((user) => user.id))
  }

  const mentionOutcome = async (client: TestClient) => {
    const { hiddenMember, coMember } = fixture
    const message = await sendMessage(
      client,
      workspaceId,
      sharedChannelId,
      `ping @${hiddenMember.slug} and @${coMember.slug}`
    )
    const { rows } = await pool.query<{ content_markdown: string }>(
      `SELECT content_markdown FROM messages WHERE id = $1`,
      [message.id]
    )
    const pointer = /\[@[^\]]+\]\(user:(usr_[^)]+)\)/g
    const markdown = rows[0].content_markdown
    const plainText = markdown.replace(pointer, "")
    return {
      pointers: labelsOf([...markdown.matchAll(pointer)].map((match) => match[1])),
      plain: labelsOf(
        [hiddenMember, coMember].filter((user) => plainText.includes(`@${user.slug}`)).map((user) => user.id)
      ),
    }
  }

  beforeAll(async () => {
    const login = async (label: string) => {
      const client = new TestClient()
      const workos = await loginAs(
        client,
        `guestppl-${label}-${testRunId}@test.com`,
        `Guest People ${label} ${testRunId}`
      )
      return { client, workosUserId: workos.id }
    }
    const owner = await login("owner")
    const guestLogin = await login("guest")
    const coMemberLogin = await login("comember")
    const openMemberLogin = await login("open")
    const hiddenMemberLogin = await login("hidden")
    guestClient = guestLogin.client
    coMemberClient = coMemberLogin.client

    const workspace = await createWorkspace(owner.client, `Guest People WS ${testRunId}`)
    workspaceId = workspace.id
    const ownerUser = (await getWorkspaceBootstrap(owner.client, workspaceId)).users.find(
      (user) => user.workosUserId === owner.workosUserId
    )!
    const guest = await joinWorkspace(guestClient, workspaceId)
    const coMember = await joinWorkspace(coMemberClient, workspaceId)
    const openMember = await joinWorkspace(openMemberLogin.client, workspaceId)
    const hiddenMember = await joinWorkspace(hiddenMemberLogin.client, workspaceId)
    fixture = { owner: ownerUser, guest, coMember, openMember, hiddenMember }

    const sharedChannel = await createChannel(owner.client, workspaceId, `gp-shared-${testRunId}`, "private")
    const openChannel = await createChannel(owner.client, workspaceId, `gp-open-${testRunId}`, "public")
    const hiddenChannel = await createChannel(owner.client, workspaceId, `gp-hidden-${testRunId}`, "public")
    sharedChannelId = sharedChannel.id
    await pool.query(`UPDATE streams SET visibility = 'guest_public' WHERE workspace_id = $1 AND id = $2`, [
      workspaceId,
      openChannel.id,
    ])
    for (const [channelId, user] of [
      [sharedChannel.id, guest],
      [sharedChannel.id, coMember],
      [openChannel.id, openMember],
      [hiddenChannel.id, hiddenMember],
    ] as const) {
      expect((await addStreamMember(owner.client, workspaceId, channelId, user.id)).status).toBe(201)
    }

    await pool.query(`UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2`, [
      workspaceId,
      guest.id,
      WORKSPACE_ROLE_SLUGS.GUEST,
    ])
    // User-key auth 401s OWNER_INACTIVE without a mirror row; the e2e harness has no control plane to write one.
    for (const [user, role] of [
      [guest, WORKSPACE_ROLE_SLUGS.GUEST],
      [coMember, WORKSPACE_ROLE_SLUGS.MEMBER],
    ] as const) {
      await pool.query(
        `INSERT INTO workspace_user_permissions (workspace_id, workos_user_id, role_slugs, status, last_event_at)
         VALUES ($1, $2, $3, 'active', now())`,
        [workspaceId, user.workosUserId, [role]]
      )
    }

    const mintKey = async (client: TestClient) => {
      const response = await client.post<{ value: string }>(`/api/workspaces/${workspaceId}/user-api-keys`, {
        name: `guest-people-${testRunId}`,
        scopes: ["users:read"],
      })
      if (response.status !== 201) {
        throw new Error(`Create user key failed (${response.status}): ${JSON.stringify(response.data)}`)
      }
      return response.data.value
    }
    userKeys = { guest: await mintKey(guestClient), coMember: await mintKey(coMemberClient) }
  })

  test("should list only the guest's visible people in bootstrap users and the public API when the viewer is a guest, and everyone when a member", async () => {
    const seen = {
      guest: ["coMember", "guest", "openMember", "owner"],
      coMember: ["coMember", "guest", "hiddenMember", "openMember", "owner"],
    }

    expect({
      bootstrap: { guest: await bootstrapLabels(guestClient), coMember: await bootstrapLabels(coMemberClient) },
      publicApi: { guest: await publicApiLabels(userKeys.guest), coMember: await publicApiLabels(userKeys.coMember) },
    }).toEqual({ bootstrap: seen, publicApi: seen })
  })

  test("should resolve a bare mention to a user pointer only when the sender may see that user", async () => {
    expect({
      guest: await mentionOutcome(guestClient),
      coMember: await mentionOutcome(coMemberClient),
    }).toEqual({
      guest: { pointers: ["coMember"], plain: ["hiddenMember"] },
      coMember: { pointers: ["coMember", "hiddenMember"], plain: [] },
    })
  })
})
