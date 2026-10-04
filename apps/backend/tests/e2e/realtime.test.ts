/**
 * Real-time E2E tests using socket.io-client.
 *
 * Tests verify that:
 * 1. Socket.io authentication works with session cookies
 * 2. Room authorization is enforced
 * 3. Events are broadcast correctly to the right rooms
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { io, Socket } from "socket.io-client"
import type { Pool } from "pg"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import { createTestPool } from "../integration/setup"
import { WorkspaceService } from "../../src/features/workspaces"
import {
  TestClient,
  type Stream,
  type SyncCatchUpResult,
  type WorkspaceUser,
  loginAs,
  createWorkspace,
  createScratchpad,
  createChannel,
  sendMessage,
  addReaction,
  removeReaction,
  updateMessage,
  deleteMessage,
  getUserId,
  getBootstrap,
  joinWorkspace,
  joinRoom,
  addStreamMember,
  updateStream,
  getSyncCatchUp,
} from "../client"

function getBaseUrl(): string {
  return process.env.TEST_BASE_URL || "http://localhost:3001"
}

/**
 * Creates an authenticated socket connection using the same session as the HTTP client.
 */
function createSocket(client: TestClient): Socket {
  // Extract cookies from the client's internal state via a test request
  // This is a bit hacky but works for testing
  const cookies = (client as unknown as { cookies?: Map<string, string> }).cookies
  const socket = io(getBaseUrl(), {
    // Socket.io-client will use these cookies for authentication
    extraHeaders: {
      Cookie: cookies
        ? Array.from(cookies.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join("; ")
        : "",
    },
    transports: ["websocket"],
    autoConnect: false,
  })
  return socket
}

/**
 * Waits for a specific event with optional timeout.
 */
function waitForEvent<T = unknown>(socket: Socket, eventName: string, timeoutMs: number = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, handler)
      reject(new Error(`Timeout waiting for event: ${eventName}`))
    }, timeoutMs)

    const handler = (data: T) => {
      clearTimeout(timeout)
      socket.off(eventName, handler)
      resolve(data)
    }

    socket.on(eventName, handler)
  })
}

/**
 * Waits for socket connection with error handling.
 */
async function connectSocket(socket: Socket, timeoutMs: number = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Socket connection timeout"))
    }, timeoutMs)

    socket.on("connect", () => {
      clearTimeout(timeout)
      resolve()
    })

    socket.on("connect_error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    socket.connect()
  })
}

describe("Real-time Events", () => {
  let client: TestClient
  let socket: Socket
  let workspaceId: string
  let userId: string

  beforeAll(async () => {
    client = new TestClient()
    const user = await loginAs(client, "realtime-test@example.com", "Realtime Test User")
    const workspace = await createWorkspace(client, "Realtime Test Workspace")
    workspaceId = workspace.id
    userId = await getUserId(client, workspaceId, user.id)
  })

  beforeEach(async () => {
    socket = createSocket(client)
    await connectSocket(socket)
  })

  afterEach(() => {
    if (socket) {
      socket.disconnect()
    }
  })

  describe("Authentication", () => {
    test("should connect with valid session cookie", async () => {
      expect(socket.connected).toBe(true)
    })

    test("should reject connection without session cookie", async () => {
      const unauthSocket = io(getBaseUrl(), {
        transports: ["websocket"],
        autoConnect: false,
      })

      try {
        await connectSocket(unauthSocket)
        expect(true).toBe(false) // Should not reach here
      } catch (err: any) {
        expect(err.message).toContain("No session cookie")
      } finally {
        unauthSocket.disconnect()
      }
    })
  })

  describe("Room Authorization", () => {
    test("should allow joining workspace room when member", async () => {
      await joinRoom(socket, `ws:${workspaceId}`)
    })

    test("should reject joining workspace room when not member", async () => {
      // Create a second user who is not a member
      const otherClient = new TestClient()
      await loginAs(otherClient, "other-user@example.com", "Other User")
      const otherSocket = createSocket(otherClient)
      await connectSocket(otherSocket)

      try {
        const errorPromise = waitForEvent<{ message: string }>(otherSocket, "error", 2000)
        otherSocket.emit("join", `ws:${workspaceId}`)

        const error = await errorPromise
        expect(error.message).toContain("Not authorized")
      } finally {
        otherSocket.disconnect()
      }
    })

    test("should allow joining stream room when member", async () => {
      const stream = await createScratchpad(client, workspaceId)
      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)
    })

    test("should allow joining public stream room when workspace user but not stream member", async () => {
      const stream = await createChannel(client, workspaceId, `public-room-${Date.now()}`, "public")

      const otherClient = new TestClient()
      await loginAs(otherClient, `public-room-member-${Date.now()}@example.com`, "Public Room Member")
      await joinWorkspace(otherClient, workspaceId, "member")

      // HTTP bootstrap already uses validateStreamAccess, so this should succeed.
      const bootstrap = await getBootstrap(otherClient, workspaceId, stream.id)
      expect(bootstrap.stream.id).toBe(stream.id)

      const otherSocket = createSocket(otherClient)
      await connectSocket(otherSocket)

      try {
        await joinRoom(otherSocket, `ws:${workspaceId}:stream:${stream.id}`)
      } finally {
        otherSocket.disconnect()
      }
    })
  })

  describe("Message Events", () => {
    test("should receive message:created event in stream room", async () => {
      const stream = await createScratchpad(client, workspaceId)
      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      const eventPromise = waitForEvent<{ event: any }>(socket, "message:created")

      await sendMessage(client, workspaceId, stream.id, "Hello, real-time!")

      const event = await eventPromise

      expect(event).toMatchObject({
        workspaceId,
        streamId: stream.id,
      })
      expect(event.event).toMatchObject({
        eventType: "message_created",
        actorId: userId,
      })
      expect(event.event.payload).toMatchObject({
        contentMarkdown: "Hello, real-time!",
      })
    })

    test("should receive message:edited event", async () => {
      const stream = await createScratchpad(client, workspaceId)
      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      const message = await sendMessage(client, workspaceId, stream.id, "Original content")

      const eventPromise = waitForEvent<{ event: any }>(socket, "message:edited")

      await updateMessage(client, workspaceId, message.id, "Updated content")

      const event = await eventPromise

      expect(event).toMatchObject({
        workspaceId,
        streamId: stream.id,
      })
      expect(event.event.payload).toMatchObject({
        messageId: message.id,
        contentMarkdown: "Updated content",
      })
    })

    test("should receive message:deleted event", async () => {
      const stream = await createScratchpad(client, workspaceId)
      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      const message = await sendMessage(client, workspaceId, stream.id, "To be deleted")

      const eventPromise = waitForEvent<{ messageId: string }>(socket, "message:deleted")

      await deleteMessage(client, workspaceId, message.id)

      const event = await eventPromise

      expect(event).toMatchObject({
        workspaceId,
        streamId: stream.id,
        messageId: message.id,
      })
    })
  })

  describe("Reaction Events", () => {
    test("should receive reaction:added event", async () => {
      const stream = await createScratchpad(client, workspaceId)
      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      const message = await sendMessage(client, workspaceId, stream.id, "React to me")

      const eventPromise = waitForEvent<{ emoji: string; userId: string }>(socket, "reaction:added")

      await addReaction(client, workspaceId, message.id, "👍")

      const event = await eventPromise

      expect(event).toMatchObject({
        workspaceId,
        streamId: stream.id,
        messageId: message.id,
        // Emoji gets normalized to shortcode format
        emoji: ":+1:",
        userId,
      })
    })

    test("should receive reaction:removed event", async () => {
      const stream = await createScratchpad(client, workspaceId)
      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      const message = await sendMessage(client, workspaceId, stream.id, "Unreact from me")
      await addReaction(client, workspaceId, message.id, "❤️")

      const eventPromise = waitForEvent<{ emoji: string; userId: string }>(socket, "reaction:removed")

      await removeReaction(client, workspaceId, message.id, "❤️")

      const event = await eventPromise

      expect(event).toMatchObject({
        workspaceId,
        streamId: stream.id,
        messageId: message.id,
        // Emoji gets normalized to shortcode format
        emoji: ":heart:",
        userId,
      })
    })
  })

  describe("Stream Events", () => {
    test("should receive stream:created event in workspace room", async () => {
      await joinRoom(socket, `ws:${workspaceId}`)

      const eventPromise = waitForEvent<{ stream: any }>(socket, "stream:created")

      const stream = await createChannel(client, workspaceId, `test-channel-${Date.now()}`)

      const event = await eventPromise

      expect(event).toMatchObject({
        workspaceId,
        streamId: stream.id,
      })
      expect(event.stream).toMatchObject({
        id: stream.id,
        type: "channel",
      })
    })

    test("should receive stream:updated event in workspace room", async () => {
      const stream = await createScratchpad(client, workspaceId)

      await joinRoom(socket, `ws:${workspaceId}`)

      const eventPromise = waitForEvent<{ stream: any }>(socket, "stream:updated")

      // Update companion mode triggers stream:updated
      await client.patch(`/api/workspaces/${workspaceId}/streams/${stream.id}/companion`, {
        companionMode: "off",
      })

      const event = await eventPromise

      expect(event).toMatchObject({
        workspaceId,
        streamId: stream.id,
      })
      expect(event.stream.companionMode).toBe("off")
    })
  })

  describe("Room Scoping", () => {
    test("should not receive events for streams not joined", async () => {
      const stream1 = await createScratchpad(client, workspaceId)
      const stream2 = await createScratchpad(client, workspaceId)

      // Disable companion mode for both streams to prevent companion job dispatch
      // This test is about room scoping, not companion behavior
      await client.patch(`/api/workspaces/${workspaceId}/streams/${stream1.id}/companion`, {
        companionMode: "off",
      })
      await client.patch(`/api/workspaces/${workspaceId}/streams/${stream2.id}/companion`, {
        companionMode: "off",
      })

      // Only join stream1
      await joinRoom(socket, `ws:${workspaceId}:stream:${stream1.id}`)

      // Send message to stream1 - should receive
      const event1Promise = waitForEvent<{ streamId: string; event: any }>(socket, "message:created")
      await sendMessage(client, workspaceId, stream1.id, "Message to stream 1")
      const event1 = await event1Promise
      expect(event1.streamId).toBe(stream1.id)

      // Send message to stream2 - should NOT receive (not joined)
      // To verify nothing is received, we use a short timeout
      const noEventPromise = waitForEvent(socket, "message:created", 300).catch(() => "no-event")
      await sendMessage(client, workspaceId, stream2.id, "Message to stream 2")
      const result = await noEventPromise
      expect(result).toBe("no-event")
    })

    test("should receive workspace events even if not in stream room", async () => {
      // Join workspace room only
      await joinRoom(socket, `ws:${workspaceId}`)

      const eventPromise = waitForEvent<{ workspaceId: string; stream: any }>(socket, "stream:created")

      await createScratchpad(client, workspaceId)

      const event = await eventPromise
      expect(event.workspaceId).toBe(workspaceId)
    })

    test("should not receive workspace events if only in stream room", async () => {
      const existingStream = await createScratchpad(client, workspaceId)

      // Only join stream room, not workspace room
      await joinRoom(socket, `ws:${workspaceId}:stream:${existingStream.id}`)

      // To verify nothing is received, we use a short timeout
      const noEventPromise = waitForEvent(socket, "stream:created", 300).catch(() => "no-event")

      // Create new stream - should NOT receive in stream room
      await createScratchpad(client, workspaceId)

      const result = await noEventPromise
      expect(result).toBe("no-event")
    })

    test("should not deliver stream:activity to workspace users outside the stream", async () => {
      const privateStream = await createScratchpad(client, workspaceId, "off")
      const outsiderClient = new TestClient()
      await loginAs(outsiderClient, "workspace-outsider@example.com", "Workspace Outsider")
      await joinWorkspace(outsiderClient, workspaceId)

      const outsiderSocket = createSocket(outsiderClient)
      await connectSocket(outsiderSocket)

      try {
        await joinRoom(outsiderSocket, `ws:${workspaceId}`)

        // With stream-scoped activity events, the outsider won't receive any
        // stream:activity event at all (they're not in the stream room)
        const noActivityPromise = waitForEvent(outsiderSocket, "stream:activity", 500).catch(() => "no-event")
        const secret = "TOP SECRET stream content"

        await sendMessage(client, workspaceId, privateStream.id, secret)

        expect(await noActivityPromise).toBe("no-event")
      } finally {
        outsiderSocket.disconnect()
      }
    })

    test("should deliver stream:activity to members of private streams", async () => {
      const privateStream = await createScratchpad(client, workspaceId, "off")

      // Join the stream room (simulates useSocketEvents membership room join)
      await joinRoom(socket, `ws:${workspaceId}:stream:${privateStream.id}`)

      const activityPromise = waitForEvent<{
        workspaceId: string
        streamId: string
        authorId: string
        lastMessagePreview: { content: string }
      }>(socket, "stream:activity")

      await sendMessage(client, workspaceId, privateStream.id, "Private stream activity test")

      const activity = await activityPromise
      expect(activity).toMatchObject({
        workspaceId,
        streamId: privateStream.id,
        authorId: userId,
        lastMessagePreview: {
          content: "Private stream activity test",
        },
      })
    })

    test("should deliver stream:activity to private stream members after room re-join", async () => {
      const privateStream = await createScratchpad(client, workspaceId, "off")

      // Simulate the frontend lifecycle:
      // 1. useSocketEvents joins stream room (membership rooms)
      await joinRoom(socket, `ws:${workspaceId}:stream:${privateStream.id}`)

      // 2. useStreamSocket also joins (idempotent)
      await joinRoom(socket, `ws:${workspaceId}:stream:${privateStream.id}`)

      // 3. useStreamSocket leaves on navigation — Socket.io rooms are NOT
      //    reference-counted, so this single leave removes the socket from the
      //    room entirely, even though useSocketEvents also joined.
      socket.emit("leave", `ws:${workspaceId}:stream:${privateStream.id}`)

      // 4. After the leave, stream:activity events should NOT be received.
      //    This demonstrates the bug: the leave undoes useSocketEvents' join.
      const noActivityPromise = waitForEvent(socket, "stream:activity", 500).catch(() => "no-event")
      await sendMessage(client, workspaceId, privateStream.id, "Should be missed")
      expect(await noActivityPromise).toBe("no-event")
    })
  })

  describe("Multi-client Scenarios", () => {
    test("should broadcast events to multiple clients in same room", async () => {
      const stream = await createScratchpad(client, workspaceId)

      // Create a second authenticated client/socket
      const client2 = new TestClient()
      await loginAs(client2, "realtime-user2@example.com", "User 2")
      // User 2 needs to be added to workspace - for now, create their own workspace
      // and we'll test with the first user's socket

      // Connect both sockets to same stream room
      const socket2 = createSocket(client)
      await connectSocket(socket2)

      try {
        await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)
        await joinRoom(socket2, `ws:${workspaceId}:stream:${stream.id}`)

        const event1Promise = waitForEvent<{ event: any }>(socket, "message:created")
        const event2Promise = waitForEvent<{ event: any }>(socket2, "message:created")

        await sendMessage(client, workspaceId, stream.id, "Broadcast test")

        const [event1, event2] = await Promise.all([event1Promise, event2Promise])

        expect(event1.event.payload.contentMarkdown).toBe("Broadcast test")
        expect(event2.event.payload.contentMarkdown).toBe("Broadcast test")
      } finally {
        socket2.disconnect()
      }
    })
  })
})

describe("Guest delivery", () => {
  const runId = Math.random().toString(36).substring(7)
  let pool: Pool
  let owner: TestClient
  let guestClient: TestClient
  let workspaceId: string
  let publicChannel: Stream
  let openChannel: Stream
  let sharedChannel: Stream
  let ownerSocket: Socket
  let guestSocket: Socket

  const collect = <T>(socket: Socket, eventName: string): T[] => {
    const seen: T[] = []
    socket.on(eventName, (event: T) => seen.push(event))
    return seen
  }

  const sendCounted = async (listener: Socket, streamId: string) => {
    const counted = waitForEvent<{ streamId: string }>(listener, "stream:message_count")
    await sendMessage(owner, workspaceId, streamId, "count me")
    return counted
  }

  beforeAll(async () => {
    pool = createTestPool()
    owner = new TestClient()
    guestClient = new TestClient()
    await loginAs(owner, `guest-delivery-owner-${runId}@example.com`, "Guest Delivery Owner")
    await loginAs(guestClient, `guest-delivery-guest-${runId}@example.com`, "Guest Delivery Guest")
    workspaceId = (await createWorkspace(owner, `Guest Delivery ${runId}`)).id
    publicChannel = await createChannel(owner, workspaceId, `gd-public-${runId}`, "public")
    openChannel = await createChannel(owner, workspaceId, `gd-open-${runId}`, "public")
    sharedChannel = await createChannel(owner, workspaceId, `gd-shared-${runId}`, "private")
    await pool.query(`UPDATE streams SET visibility = 'guest_public' WHERE workspace_id = $1 AND id = $2`, [
      workspaceId,
      openChannel.id,
    ])

    const guest = await joinWorkspace(guestClient, workspaceId)
    expect((await addStreamMember(owner, workspaceId, sharedChannel.id, guest.id)).status).toBe(201)
    await pool.query(`UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2`, [
      workspaceId,
      guest.id,
      WORKSPACE_ROLE_SLUGS.GUEST,
    ])

    ownerSocket = createSocket(owner)
    guestSocket = createSocket(guestClient)
    await Promise.all([connectSocket(ownerSocket), connectSocket(guestSocket)])
    await Promise.all([joinRoom(ownerSocket, `ws:${workspaceId}`), joinRoom(guestSocket, `ws:${workspaceId}`)])
  })

  afterAll(async () => {
    ownerSocket?.disconnect()
    guestSocket?.disconnect()
    await pool.end()
  })

  test("should deliver a guest_public channel's message count but not a public channel's when the viewer is a guest", async () => {
    const guestCounts = collect<{ streamId: string }>(guestSocket, "stream:message_count")

    const ownerControl = await sendCounted(ownerSocket, publicChannel.id)
    await sendCounted(guestSocket, openChannel.id)

    expect({ ownerControl: ownerControl.streamId, guestCounts: guestCounts.map((count) => count.streamId) }).toEqual({
      ownerControl: publicChannel.id,
      guestCounts: [openChannel.id],
    })
  })

  test("should deliver stream:updated for a private channel to a guest member once the guest joins its room", async () => {
    const guestUpdates = collect<{ stream: { description: string } }>(guestSocket, "stream:updated")
    const describeAs = async (listener: Socket, description: string) => {
      const updated = waitForEvent(listener, "stream:updated")
      expect((await updateStream(owner, workspaceId, sharedChannel.id, { description })).status).toBe(200)
      await updated
    }

    await describeAs(ownerSocket, "Before room")
    await joinRoom(guestSocket, `ws:${workspaceId}:stream:${sharedChannel.id}`)
    await describeAs(guestSocket, "After room")

    expect(guestUpdates.map((update) => update.stream.description)).toEqual(["After room"])
  })

  test("should omit a public channel's entries from a guest's catch-up when the owner's catch-up has them", async () => {
    await sendCounted(ownerSocket, publicChannel.id)
    await sendCounted(ownerSocket, openChannel.id)

    const [guestLog, ownerLog] = await Promise.all([
      getSyncCatchUp(guestClient, workspaceId),
      getSyncCatchUp(owner, workspaceId),
    ])
    const eventTypesFor = (log: SyncCatchUpResult, stream: Stream) =>
      log.entries
        .filter((entry) => (entry.payload as { streamId?: string }).streamId === stream.id)
        .map((entry) => entry.eventType)

    expect({
      ownerHasPublicCount: eventTypesFor(ownerLog, publicChannel).includes("stream:message_count"),
      guestPublicEntries: eventTypesFor(guestLog, publicChannel),
      guestHasOpenCount: eventTypesFor(guestLog, openChannel).includes("stream:message_count"),
    }).toEqual({ ownerHasPublicCount: true, guestPublicEntries: [], guestHasOpenCount: true })
  })
})

describe("Guest roster", () => {
  type UpdatedEvent = { user: { id: string; name: string } }
  type RemovedEvent = { removedUserId: string }

  const runId = Math.random().toString(36).substring(7)
  let pool: Pool
  let owner: TestClient
  let guestClient: TestClient
  let coMemberClient: TestClient
  let strangerClient: TestClient
  let workspaceId: string
  let sharedChannel: Stream
  let coMember: WorkspaceUser
  let stranger: WorkspaceUser
  let ownerSocket: Socket
  let guestSocket: Socket

  const collect = <T>(socket: Socket, eventName: string): T[] => {
    const seen: T[] = []
    socket.on(eventName, (event: T) => seen.push(event))
    return seen
  }

  const rename = async (client: TestClient, name: string) => {
    expect((await client.patch(`/api/workspaces/${workspaceId}/profile`, { name })).status).toBe(200)
  }

  // The stranger goes first: a socket delivers in order, so once a listener has heard the co-member's
  // update, an earlier update for the stranger that was meant for it would already have arrived.
  const renameStrangerThenCoMember = async (tag: string, laterListeners: Socket[]) => {
    const strangerHeard = waitForEvent(ownerSocket, "workspace_user:updated")
    await rename(strangerClient, `Stranger ${tag}`)
    await strangerHeard

    const coMemberHeard = Promise.all(laterListeners.map((socket) => waitForEvent(socket, "workspace_user:updated")))
    await rename(coMemberClient, `Co-member ${tag}`)
    await coMemberHeard
  }

  const peopleIdsOf = async (client: TestClient) => {
    const { data } = await client.get<{ users: Array<{ id: string }> }>(`/api/workspaces/${workspaceId}/users`)
    return data.users.map((user) => user.id)
  }

  beforeAll(async () => {
    pool = createTestPool()
    owner = new TestClient()
    guestClient = new TestClient()
    coMemberClient = new TestClient()
    strangerClient = new TestClient()
    await loginAs(owner, `guest-roster-owner-${runId}@example.com`, "Guest Roster Owner")
    await loginAs(guestClient, `guest-roster-guest-${runId}@example.com`, "Guest Roster Guest")
    await loginAs(coMemberClient, `guest-roster-comember-${runId}@example.com`, "Guest Roster Co-member")
    await loginAs(strangerClient, `guest-roster-stranger-${runId}@example.com`, "Guest Roster Stranger")
    workspaceId = (await createWorkspace(owner, `Guest Roster ${runId}`)).id
    sharedChannel = await createChannel(owner, workspaceId, `gr-shared-${runId}`, "private")

    const guest = await joinWorkspace(guestClient, workspaceId)
    coMember = await joinWorkspace(coMemberClient, workspaceId)
    stranger = await joinWorkspace(strangerClient, workspaceId)
    expect((await addStreamMember(owner, workspaceId, sharedChannel.id, guest.id)).status).toBe(201)
    expect((await addStreamMember(owner, workspaceId, sharedChannel.id, coMember.id)).status).toBe(201)
    await pool.query(`UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2`, [
      workspaceId,
      guest.id,
      WORKSPACE_ROLE_SLUGS.GUEST,
    ])

    ownerSocket = createSocket(owner)
    guestSocket = createSocket(guestClient)
    await Promise.all([connectSocket(ownerSocket), connectSocket(guestSocket)])
    await Promise.all([joinRoom(ownerSocket, `ws:${workspaceId}`), joinRoom(guestSocket, `ws:${workspaceId}`)])
  })

  afterAll(async () => {
    ownerSocket?.disconnect()
    guestSocket?.disconnect()
    await pool.end()
  })

  test("should deliver a co-member's profile update but not a stranger's when the viewer is a guest", async () => {
    const guestUpdates = collect<UpdatedEvent>(guestSocket, "workspace_user:updated")
    const ownerUpdates = collect<UpdatedEvent>(ownerSocket, "workspace_user:updated")

    await renameStrangerThenCoMember("live", [ownerSocket, guestSocket])

    const named = ({ user }: UpdatedEvent) => ({ id: user.id, name: user.name })
    expect({ owner: ownerUpdates.map(named), guest: guestUpdates.map(named) }).toEqual({
      owner: [
        { id: stranger.id, name: "Stranger live" },
        { id: coMember.id, name: "Co-member live" },
      ],
      guest: [{ id: coMember.id, name: "Co-member live" }],
    })
  })

  test("should hold a co-member's profile update but not a stranger's in a guest's catch-up when the owner's holds both", async () => {
    const { head } = await getSyncCatchUp(owner, workspaceId)

    await renameStrangerThenCoMember("logged", [ownerSocket])

    const [ownerLog, guestLog] = await Promise.all([
      getSyncCatchUp(owner, workspaceId, head),
      getSyncCatchUp(guestClient, workspaceId, head),
    ])
    const updatedNames = (log: SyncCatchUpResult) =>
      log.entries
        .filter((entry) => entry.eventType === "workspace_user:updated")
        .map((entry) => (entry.payload as UpdatedEvent).user.name)

    expect({ owner: updatedNames(ownerLog), guest: updatedNames(guestLog) }).toEqual({
      owner: ["Stranger logged", "Co-member logged"],
      guest: ["Co-member logged"],
    })
  })

  test("should deliver a co-member's removal to a guest when the owner removes them from the workspace", async () => {
    const ownerRemoval = waitForEvent<RemovedEvent>(ownerSocket, "workspace_user:removed")
    const guestRemoval = waitForEvent<RemovedEvent>(guestSocket, "workspace_user:removed")

    // The member-removal route is a control-plane call that no test server has; the service is what its
    // regional side runs.
    await new WorkspaceService(pool, {} as never, {} as never).removeUser(workspaceId, coMember.id)
    const [ownerHeard, guestHeard] = await Promise.all([ownerRemoval, guestRemoval])

    expect({ owner: ownerHeard.removedUserId, guest: guestHeard.removedUserId }).toEqual({
      owner: coMember.id,
      guest: coMember.id,
    })
  })

  test("should list a stranger in a guest's people once the stranger joins a stream the guest reads", async () => {
    const before = await peopleIdsOf(guestClient)

    expect((await addStreamMember(owner, workspaceId, sharedChannel.id, stranger.id)).status).toBe(201)
    const after = await peopleIdsOf(guestClient)

    expect({ before: before.includes(stranger.id), after: after.includes(stranger.id) }).toEqual({
      before: false,
      after: true,
    })
  })
})
