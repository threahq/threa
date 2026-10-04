import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamErrorCodes, WORKSPACE_ROLE_SLUGS, permissionsForRole } from "@threahq/types"
import { createTestPool } from "../integration/setup"
import {
  TestClient,
  addStreamMember,
  createChannel,
  createScratchpad,
  createThread,
  createWorkspace,
  getBaseUrl,
  getStream,
  getWorkspaceBootstrap,
  joinWorkspace,
  loginAs,
  sendMessage,
  updateStream,
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

describe("guest reads of channels created over HTTP", () => {
  test("should let a guest read a guest_public channel's messages and not a public channel's", async () => {
    const owner = new TestClient()
    const guestClient = new TestClient()
    await loginAs(owner, `guestread-owner-${testRunId}@test.com`, "Guest Read Owner")
    await loginAs(guestClient, `guestread-guest-${testRunId}@test.com`, "Guest Read Guest")
    const workspace = await createWorkspace(owner, `Guest Read WS ${testRunId}`)

    const guestPublic = await createChannel(owner, workspace.id, `gr-open-${testRunId}`, "guest_public")
    const memberOnly = await createChannel(owner, workspace.id, `gr-public-${testRunId}`, "public")
    await sendMessage(owner, workspace.id, guestPublic.id, "for everyone")
    await sendMessage(owner, workspace.id, memberOnly.id, "for members")

    const guest = await joinWorkspace(guestClient, workspace.id)
    await pool.query(`UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2`, [
      workspace.id,
      guest.id,
      WORKSPACE_ROLE_SLUGS.GUEST,
    ])

    const read = async (streamId: string) => {
      const response = await guestClient.get<{ events?: Array<{ payload: { contentMarkdown: string } }> }>(
        `/api/workspaces/${workspace.id}/streams/${streamId}/events?type=message_created`
      )
      return { status: response.status, messages: response.data.events?.map((e) => e.payload.contentMarkdown) }
    }

    expect({ guestPublic: await read(guestPublic.id), public: await read(memberOnly.id) }).toEqual({
      guestPublic: { status: 200, messages: ["for everyone"] },
      public: { status: 404, messages: undefined },
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

const outcome = ({ status, data }: { status: number; data: unknown }) => ({
  status,
  code: (data as { code?: string }).code,
})

describe("guest channel management", () => {
  test("should refuse a guest creating or changing a channel while scratchpads and members are unaffected", async () => {
    const owner = new TestClient()
    const guestClient = new TestClient()
    const memberClient = new TestClient()
    await loginAs(owner, `guestmgmt-owner-${testRunId}@test.com`, "Guest Mgmt Owner")
    await loginAs(guestClient, `guestmgmt-guest-${testRunId}@test.com`, "Guest Mgmt Guest")
    await loginAs(memberClient, `guestmgmt-member-${testRunId}@test.com`, "Guest Mgmt Member")
    const workspace = await createWorkspace(owner, `Guest Mgmt WS ${testRunId}`)

    const openChannel = await createChannel(owner, workspace.id, `gm-open-${testRunId}`, "guest_public")
    expect((await updateStream(owner, workspace.id, openChannel.id, { description: "original" })).status).toBe(200)
    const guest = await joinWorkspace(guestClient, workspace.id)
    const member = await joinWorkspace(memberClient, workspace.id)
    for (const user of [guest, member]) {
      expect((await addStreamMember(owner, workspace.id, openChannel.id, user.id)).status).toBe(201)
    }
    await pool.query(`UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2`, [
      workspace.id,
      guest.id,
      WORKSPACE_ROLE_SLUGS.GUEST,
    ])

    const createStreamAs = (client: TestClient, body: Record<string, unknown>) =>
      client.post<unknown>(`/api/workspaces/${workspace.id}/streams`, body).then(outcome)
    const patchAs = (client: TestClient, streamId: string, body: Record<string, unknown>) =>
      updateStream(client, workspace.id, streamId, body).then(outcome)
    const channelState = async () => {
      const { slug, visibility, description } = await getStream(owner, workspace.id, openChannel.id)
      return { slug, visibility, description }
    }

    const forbidden = { status: 403, code: StreamErrorCodes.CHANNEL_MANAGEMENT_FORBIDDEN }
    const guestCreates = {
      private: await createStreamAs(guestClient, {
        type: "channel",
        slug: `gm-g-private-${testRunId}`,
        visibility: "private",
      }),
      public: await createStreamAs(guestClient, {
        type: "channel",
        slug: `gm-g-public-${testRunId}`,
        visibility: "public",
      }),
      guestPublic: await createStreamAs(guestClient, {
        type: "channel",
        slug: `gm-g-open-${testRunId}`,
        visibility: "guest_public",
      }),
    }
    const guestScratchpad = await createStreamAs(guestClient, { type: "scratchpad" })
    const memberChannel = await createStreamAs(memberClient, {
      type: "channel",
      slug: `gm-m-${testRunId}`,
      visibility: "private",
    })
    const guestPatches = {
      visibility: await patchAs(guestClient, openChannel.id, { visibility: "private" }),
      slug: await patchAs(guestClient, openChannel.id, { slug: `gm-renamed-${testRunId}` }),
      description: await patchAs(guestClient, openChannel.id, { description: "hijacked" }),
    }
    const channelAfterGuestPatches = await channelState()
    const guestRenamesOwnScratchpad = await patchAs(
      guestClient,
      (await createScratchpad(guestClient, workspace.id)).id,
      { displayName: "My notes" }
    )
    const memberPatch = await patchAs(memberClient, openChannel.id, { description: "by a member" })

    expect({
      guestCreates,
      guestScratchpad,
      memberChannel,
      guestPatches,
      channelAfterGuestPatches,
      guestRenamesOwnScratchpad,
      memberPatch,
    }).toEqual({
      guestCreates: { private: forbidden, public: forbidden, guestPublic: forbidden },
      guestScratchpad: { status: 201, code: undefined },
      memberChannel: { status: 201, code: undefined },
      guestPatches: { visibility: forbidden, slug: forbidden, description: forbidden },
      channelAfterGuestPatches: { slug: openChannel.slug, visibility: "guest_public", description: "original" },
      guestRenamesOwnScratchpad: { status: 200, code: undefined },
      memberPatch: { status: 200, code: undefined },
    })
  })

  test("should refuse a guest changing a channel's companion, brief or archive state while members and the tool policy are unaffected", async () => {
    const owner = new TestClient()
    const guestClient = new TestClient()
    const memberClient = new TestClient()
    const demotedCreatorClient = new TestClient()
    await loginAs(owner, `guestcfg-owner-${testRunId}@test.com`, "Guest Cfg Owner")
    await loginAs(guestClient, `guestcfg-guest-${testRunId}@test.com`, "Guest Cfg Guest")
    await loginAs(memberClient, `guestcfg-member-${testRunId}@test.com`, "Guest Cfg Member")
    await loginAs(demotedCreatorClient, `guestcfg-creator-${testRunId}@test.com`, "Guest Cfg Creator")
    const workspace = await createWorkspace(owner, `Guest Cfg WS ${testRunId}`)

    const openChannel = await createChannel(owner, workspace.id, `gc-open-${testRunId}`, "guest_public")
    const guest = await joinWorkspace(guestClient, workspace.id)
    const member = await joinWorkspace(memberClient, workspace.id)
    const demotedCreator = await joinWorkspace(demotedCreatorClient, workspace.id)
    for (const user of [guest, member]) {
      expect((await addStreamMember(owner, workspace.id, openChannel.id, user.id)).status).toBe(201)
    }
    const memberChannel = await createChannel(memberClient, workspace.id, `gc-member-${testRunId}`, "private")
    const demotedCreatorChannel = await createChannel(
      demotedCreatorClient,
      workspace.id,
      `gc-creator-${testRunId}`,
      "private"
    )
    const anchor = await sendMessage(owner, workspace.id, openChannel.id, "anchor")
    const thread = await createThread(owner, workspace.id, openChannel.id, anchor.id)
    for (const user of [guest, demotedCreator]) {
      await pool.query(`UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2`, [
        workspace.id,
        user.id,
        WORKSPACE_ROLE_SLUGS.GUEST,
      ])
    }

    const streamPath = (streamId: string) => `/api/workspaces/${workspace.id}/streams/${streamId}`
    const companionAs = (client: TestClient, streamId: string, companionMode: "on" | "off") =>
      client.patch<unknown>(`${streamPath(streamId)}/companion`, { companionMode }).then(outcome)
    const toolPolicyAs = (client: TestClient, streamId: string) =>
      client.patch<unknown>(`${streamPath(streamId)}/tool-policy`, { allowedCategories: [] }).then(outcome)
    const briefAs = (client: TestClient, streamId: string, content: string) =>
      client.put<unknown>(`${streamPath(streamId)}/brief`, { content, version: 0 }).then(outcome)
    const lifecycleAs = (client: TestClient, streamId: string, action: "archive" | "unarchive") =>
      client.post<unknown>(`${streamPath(streamId)}/${action}`).then(outcome)
    const stateOf = async (reader: TestClient, streamId: string) => {
      const { companionMode, archivedAt } = await getStream(reader, workspace.id, streamId)
      const { data } = await reader.get<{ brief: { content: string } | null }>(`${streamPath(streamId)}/brief`)
      return { companionMode, archived: archivedAt !== null, brief: data.brief?.content ?? null }
    }

    const forbidden = { status: 403, code: StreamErrorCodes.CHANNEL_MANAGEMENT_FORBIDDEN }
    const ok = { status: 200, code: undefined }
    const before = {
      channel: await stateOf(owner, openChannel.id),
      demotedCreatorChannel: await stateOf(demotedCreatorClient, demotedCreatorChannel.id),
    }
    const guestAttempts = {
      companion: await companionAs(guestClient, openChannel.id, before.channel.companionMode === "on" ? "off" : "on"),
      brief: await briefAs(guestClient, openChannel.id, "hijacked"),
      briefViaThread: await briefAs(guestClient, thread.id, "hijacked via thread"),
      archive: await lifecycleAs(guestClient, openChannel.id, "archive"),
      demotedCreatorArchive: await lifecycleAs(demotedCreatorClient, demotedCreatorChannel.id, "archive"),
    }
    const after = {
      channel: await stateOf(owner, openChannel.id),
      demotedCreatorChannel: await stateOf(demotedCreatorClient, demotedCreatorChannel.id),
    }
    const toolPolicyOnChannel = {
      guest: await toolPolicyAs(guestClient, openChannel.id),
      member: await toolPolicyAs(memberClient, openChannel.id),
    }
    const memberAttempts = {
      companion: await companionAs(memberClient, openChannel.id, before.channel.companionMode === "on" ? "off" : "on"),
      brief: await briefAs(memberClient, openChannel.id, "by a member"),
      archive: await lifecycleAs(memberClient, memberChannel.id, "archive"),
      unarchive: await lifecycleAs(memberClient, memberChannel.id, "unarchive"),
    }

    expect({ guestAttempts, after, toolPolicyOnChannel, memberAttempts }).toEqual({
      guestAttempts: {
        companion: forbidden,
        brief: forbidden,
        briefViaThread: forbidden,
        archive: forbidden,
        demotedCreatorArchive: forbidden,
      },
      after: before,
      toolPolicyOnChannel: {
        guest: { status: 400, code: "INVALID_STREAM_TYPE" },
        member: { status: 400, code: "INVALID_STREAM_TYPE" },
      },
      memberAttempts: { companion: ok, brief: ok, archive: ok, unarchive: ok },
    })
  })
})
