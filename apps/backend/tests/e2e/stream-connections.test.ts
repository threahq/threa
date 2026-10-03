import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { io, type Socket } from "socket.io-client"
import { streamConnectionId } from "@threahq/backend-common"
import type { StreamConnectionSnapshot } from "@threahq/types"
import {
  TestClient,
  createChannel,
  createWorkspace,
  getBaseUrl,
  getWorkspaceBootstrap,
  joinRoom,
  joinWorkspace,
  loginAs,
  type Stream,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)

async function connectedSocket(client: TestClient): Promise<Socket> {
  const cookies = (client as unknown as { cookies: Map<string, string> }).cookies
  const socket = io(getBaseUrl(), {
    extraHeaders: { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") },
    transports: ["websocket"],
    autoConnect: false,
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("connect_error", reject)
    socket.connect()
  })
  return socket
}

function nextEvent<T>(socket: Socket, name: string, matches: (payload: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(name, handler)
      reject(new Error(`Timed out waiting for ${name}`))
    }, 5000)
    const handler = (payload: T) => {
      if (!matches(payload)) return
      clearTimeout(timeout)
      socket.off(name, handler)
      resolve(payload)
    }
    socket.on(name, handler)
  })
}

describe("Stream connections E2E", () => {
  let owner: TestClient
  let member: TestClient
  let workspaceId: string
  let ownerId: string
  let channel: Stream
  const sockets: Socket[] = []

  beforeAll(async () => {
    owner = new TestClient()
    member = new TestClient()
    const ownerLogin = await loginAs(owner, `strconn-owner-${testRunId}@test.com`, "Connect Owner")
    workspaceId = (await createWorkspace(owner, `Connect WS ${testRunId}`)).id
    ownerId = (await getWorkspaceBootstrap(owner, workspaceId)).users.find((u) => u.workosUserId === ownerLogin.id)!.id
    channel = await createChannel(owner, workspaceId, `connect-${testRunId}`)
    await loginAs(member, `strconn-member-${testRunId}@test.com`, "Connect Member")
    await joinWorkspace(member, workspaceId, "member")
  })

  afterAll(() => {
    for (const socket of sockets) socket.disconnect()
  })

  function invitedSnapshot(hostStreamId: string): StreamConnectionSnapshot {
    return {
      id: streamConnectionId(),
      revision: 1,
      state: "invited",
      hostWorkspaceId: workspaceId,
      hostWorkspaceName: `Connect WS ${testRunId}`,
      hostRegion: "local",
      hostStreamId,
      invitedBy: "usr_inviter",
      partnerWorkspaceId: null,
      partnerWorkspaceName: null,
      partnerRegion: null,
      partnerVisibility: null,
      acceptedBy: null,
      peerWorkspaceIds: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
  }

  test("should refuse every share action to a workspace member who isn't an admin", async () => {
    const base = `/api/workspaces/${workspaceId}`
    const responses = await Promise.all([
      member.get(`${base}/streams/${channel.id}/connections`),
      member.post(`${base}/streams/${channel.id}/connection-invites`, {}),
      member.post(`${base}/stream-connections/${streamConnectionId()}/revoke`, {}),
      member.post(`${base}/stream-connections/accept`, { token: "tok", visibility: "private" }),
      member.get(`${base}/stream-connections/can-accept`),
    ])

    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403])
  })

  test("should tell an admin they can't accept while the workspace flag is off", async () => {
    const response = await owner.get(`/api/workspaces/${workspaceId}/stream-connections/can-accept`)

    expect({ status: response.status, body: response.data }).toEqual({
      status: 404,
      body: expect.objectContaining({ code: "STREAM_CONNECTIONS_DISABLED" }),
    })
  })

  test("should name a channel but call it not shareable while the workspace flag is off", async () => {
    const query = new URLSearchParams({ workspaceId, streamId: channel.id, invitedBy: ownerId })
    const response = await owner.internalRequest("GET", `/internal/stream-connections/channel?${query}`)

    expect({ status: response.status, body: response.data }).toEqual({
      status: 200,
      body: { shareable: false, slug: channel.slug, displayName: channel.displayName },
    })
  })

  test("should accept a valid snapshot, ignore unknown keys, and reject a malformed one on the internal sync endpoint", async () => {
    const snapshot = invitedSnapshot(channel.id)

    const [valid, newerControlPlane, malformed] = await Promise.all([
      owner.internalRequest("POST", "/internal/stream-connections", snapshot),
      owner.internalRequest("POST", "/internal/stream-connections", {
        ...snapshot,
        id: streamConnectionId(),
        fieldFromNewerControlPlane: true,
      }),
      owner.internalRequest("POST", "/internal/stream-connections", { ...snapshot, revision: "one" }),
    ])

    expect({ valid: valid.status, newerControlPlane: newerControlPlane.status, malformed: malformed.status }).toEqual({
      valid: 204,
      newerControlPlane: 204,
      malformed: 400,
    })
  })

  test("should stop sending a public channel's link changes to an admin's open tab once they're demoted, and resume on promotion", async () => {
    const admin = new TestClient()
    await loginAs(admin, `strconn-admin-${testRunId}@test.com`, "Connect Admin")
    const adminUser = await joinWorkspace(admin, workspaceId, "admin")
    const publicChannel = await createChannel(owner, workspaceId, `connect-public-${testRunId}`, "public")
    const [ownerSocket, adminSocket] = await Promise.all([connectedSocket(owner), connectedSocket(admin)])
    sockets.push(ownerSocket, adminSocket)
    await Promise.all([joinRoom(ownerSocket, `ws:${workspaceId}`), joinRoom(adminSocket, `ws:${workspaceId}`)])

    type Update = { connection: { id: string } }
    const seenByAdmin: string[] = []
    adminSocket.on("stream_connection:updated", (payload: Update) => seenByAdmin.push(payload.connection.id))
    const publish = async (deliveredTo: Socket) => {
      const snapshot = invitedSnapshot(publicChannel.id)
      const delivered = nextEvent<Update>(
        deliveredTo,
        "stream_connection:updated",
        (p) => p.connection.id === snapshot.id
      )
      await owner.internalRequest("POST", "/internal/stream-connections", snapshot)
      await delivered
      return snapshot.id
    }
    let changedAt = Date.now()
    const changeRole = async (role: "member" | "admin") => {
      const applied = nextEvent<{ user: { id: string; role: string } }>(
        adminSocket,
        "workspace_user:updated",
        (p) => p.user.id === adminUser.id && p.user.role === role
      )
      await owner.internalRequest("POST", "/internal/authz/memberships", {
        kind: "upsert",
        workspaceId,
        workosUserId: adminUser.workosUserId,
        roleSlugs: [role],
        status: "active",
        lastEventAt: new Date(++changedAt).toISOString(),
      })
      await applied
    }

    const whileAdmin = await publish(adminSocket)
    await changeRole("member")
    await publish(ownerSocket)
    await changeRole("admin")
    // Events reach one socket in order, so this arriving rules out the one sent while demoted.
    const afterPromotion = await publish(adminSocket)

    expect(seenByAdmin).toEqual([whileAdmin, afterPromotion])
  })

  test("should send a private channel's link changes only to its admin members, not to every admin", async () => {
    const outsiderAdmin = new TestClient()
    await loginAs(outsiderAdmin, `strconn-outsider-${testRunId}@test.com`, "Connect Outsider")
    await joinWorkspace(outsiderAdmin, workspaceId, "admin")
    const privateChannel = await createChannel(owner, workspaceId, `connect-private-${testRunId}`, "private")
    const publicChannel = await createChannel(owner, workspaceId, `connect-public-b-${testRunId}`, "public")
    const [ownerSocket, outsiderSocket] = await Promise.all([connectedSocket(owner), connectedSocket(outsiderAdmin)])
    sockets.push(ownerSocket, outsiderSocket)
    await Promise.all([joinRoom(ownerSocket, `ws:${workspaceId}`), joinRoom(outsiderSocket, `ws:${workspaceId}`)])

    type Update = { connection: { id: string } }
    const seenByOutsider: string[] = []
    outsiderSocket.on("stream_connection:updated", (payload: Update) => seenByOutsider.push(payload.connection.id))
    const privateLink = invitedSnapshot(privateChannel.id)
    const publicLink = invitedSnapshot(publicChannel.id)
    const ownerGotPrivate = nextEvent<Update>(
      ownerSocket,
      "stream_connection:updated",
      (p) => p.connection.id === privateLink.id
    )
    const outsiderGotPublic = nextEvent<Update>(
      outsiderSocket,
      "stream_connection:updated",
      (p) => p.connection.id === publicLink.id
    )

    await owner.internalRequest("POST", "/internal/stream-connections", privateLink)
    await ownerGotPrivate
    await owner.internalRequest("POST", "/internal/stream-connections", publicLink)
    // Events reach one socket in order, so this arriving rules out the private one.
    await outsiderGotPublic

    expect(seenByOutsider).toEqual([publicLink.id])
  })
})
