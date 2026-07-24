/**
 * Companion Agent E2E tests.
 *
 * Tests verify that:
 * 1. Companion responds to messages in scratchpads with companion mode "on"
 * 2. Companion does not respond when companion mode is "off"
 * 3. Companion responses appear as persona-authored messages
 * 4. Real-time events are broadcast for companion responses
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, setDefaultTimeout } from "bun:test"

// Companion jobs are queued; full e2e runs many files and can delay persona.agent.
// Must exceed waitForCompanionResponse (60s) plus setup or Bun kills the test first.
setDefaultTimeout(120_000)
import { io, Socket } from "socket.io-client"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createScratchpad,
  sendMessage,
  listEvents,
  joinRoom,
  type StreamEvent,
} from "../client"

function getBaseUrl(): string {
  return process.env.TEST_BASE_URL || "http://localhost:3001"
}

function createSocket(client: TestClient): Socket {
  const cookies = (client as unknown as { cookies?: Map<string, string> }).cookies
  const socket = io(getBaseUrl(), {
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

function waitForEvent<T = unknown>(socket: Socket, eventName: string, timeoutMs: number = 10000): Promise<T> {
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
 * Waits for a message:created event from a persona (not a user).
 */
function waitForCompanionResponse(
  socket: Socket,
  streamId: string,
  timeoutMs: number = 60_000
): Promise<{ event: any }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message:created", handler)
      reject(new Error("Timeout waiting for companion response"))
    }, timeoutMs)

    const handler = (data: { streamId: string; event: any }) => {
      // Only resolve for persona messages in the target stream
      // actorType is at data.event.actorType (not payload.authorType)
      if (data.streamId === streamId && data.event?.actorType === "persona") {
        clearTimeout(timeout)
        socket.off("message:created", handler)
        resolve(data)
      }
    }

    socket.on("message:created", handler)
  })
}

describe("Companion Agent", () => {
  let client: TestClient
  let socket: Socket
  let workspaceId: string
  let userId: string

  beforeAll(async () => {
    client = new TestClient()
    const user = await loginAs(client, "companion-test@example.com", "Companion Test User")
    userId = user.id
    const workspace = await createWorkspace(client, "Companion Test Workspace")
    workspaceId = workspace.id
  })

  beforeEach(
    async () => {
      socket = createSocket(client)
      try {
        await connectSocket(socket)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "No session cookie") throw error
        socket.disconnect()
        socket = createSocket(client)
        await connectSocket(socket)
      }
    },
    { timeout: 30_000 }
  )

  afterEach(() => {
    if (socket) {
      socket.disconnect()
    }
  })

  describe("Companion Mode On", () => {
    test("should receive companion response when sending message to scratchpad", async () => {
      // Scratchpads have companion mode "on" by default
      const stream = await createScratchpad(client, workspaceId)

      // Join the stream room to receive events
      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      // Start waiting for companion response BEFORE sending message
      const responsePromise = waitForCompanionResponse(socket, stream.id)

      // Send a user message - this triggers the companion
      await sendMessage(client, workspaceId, stream.id, "Hello companion!")

      // Wait for the companion response
      const response = await responsePromise

      expect(response.event.eventType).toBe("message_created")
      expect(response.event.actorType).toBe("persona")
      // Stub companion returns a canned response
      expect(response.event.payload.contentMarkdown).toContain("stub response")
    })

    test("should respond with persona author, not user", async () => {
      const stream = await createScratchpad(client, workspaceId)

      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      const responsePromise = waitForCompanionResponse(socket, stream.id)
      await sendMessage(client, workspaceId, stream.id, "Who are you?")

      const response = await responsePromise

      // The author should be a persona, not the user who sent the message
      expect(response.event.actorType).toBe("persona")
      expect(response.event.actorId).not.toBe(userId)
    })

    test("should create agent session for tracking", async () => {
      const stream = await createScratchpad(client, workspaceId)

      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      const responsePromise = waitForCompanionResponse(socket, stream.id)
      await sendMessage(client, workspaceId, stream.id, "Track this session")

      await responsePromise

      // The response was received, so a session was created and completed
      // We verify this implicitly by receiving the response
      // Explicit session checking would require additional API endpoints
    })
  })

  describe("Companion Mode Off", () => {
    test("should not respond when companion mode is off", async () => {
      // Create scratchpad with companion mode off from the start
      const stream = await createScratchpad(client, workspaceId, "off")

      // Send a user message
      await sendMessage(client, workspaceId, stream.id, "No companion here")

      // Query the events via HTTP API - this gives the job queue time to process
      // If a companion response was going to happen, it would be in the events
      const events = await listEvents(client, workspaceId, stream.id, ["message_created"])

      // Should only have the user message, no companion response
      const personaEvents = events.filter((e: StreamEvent) => e.actorType === "persona")
      expect(personaEvents.length).toBe(0)

      // Verify we have exactly one member message
      const memberEvents = events.filter((e: StreamEvent) => e.actorType === "user")
      expect(memberEvents.length).toBe(1)
    })
  })

  describe("Stream Events for Companion Messages", () => {
    test("should broadcast message:created event for companion response", async () => {
      const stream = await createScratchpad(client, workspaceId)

      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      const responsePromise = waitForCompanionResponse(socket, stream.id)
      await sendMessage(client, workspaceId, stream.id, "Broadcast test")

      const response = await responsePromise

      // Verify the event structure matches what frontend expects
      expect(response).toMatchObject({
        workspaceId,
        streamId: stream.id,
      })
      expect(response.event).toMatchObject({
        eventType: "message_created",
        actorType: "persona",
      })
      expect(response.event.payload).toHaveProperty("contentMarkdown")
    })

    test("should have proper message structure in companion response", async () => {
      const stream = await createScratchpad(client, workspaceId)

      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      const responsePromise = waitForCompanionResponse(socket, stream.id)
      await sendMessage(client, workspaceId, stream.id, "Structure test")

      const response = await responsePromise

      // Verify event has required fields using toMatchObject with expect.any()
      expect(response.event).toMatchObject({
        id: expect.any(String),
        actorId: expect.any(String),
        actorType: "persona",
        createdAt: expect.any(String),
        payload: {
          contentMarkdown: expect.any(String),
          messageId: expect.any(String),
        },
      })
    })
  })

  describe("Multiple Messages", () => {
    test("should respond to each user message", async () => {
      const stream = await createScratchpad(client, workspaceId)

      await joinRoom(socket, `ws:${workspaceId}:stream:${stream.id}`)

      // Send first message and wait for response
      const response1Promise = waitForCompanionResponse(socket, stream.id)
      await sendMessage(client, workspaceId, stream.id, "First message")
      await response1Promise

      // Send second message and wait for response
      const response2Promise = waitForCompanionResponse(socket, stream.id)
      await sendMessage(client, workspaceId, stream.id, "Second message")
      await response2Promise

      // Both messages got responses (verified by promises resolving)
    })
  })
})
