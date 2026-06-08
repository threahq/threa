/**
 * E2E API tests - black box testing via HTTP.
 *
 * The test server starts automatically via setup.ts preload.
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/
 */

import { describe, test, expect } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createScratchpad,
  createChannel,
  listStreams,
  getStream,
  sendMessage,
  listEvents,
  addReaction,
  removeReaction,
  updateCompanionMode,
  updateMessage,
  deleteMessage,
  getWorkspaceBootstrap,
  getUserId,
} from "../client"

// Generate unique identifier for this test run to avoid collisions
const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-${testRunId}@test.com`

describe("API E2E Tests", () => {
  describe("Health", () => {
    test("should return minimal liveness payload", async () => {
      const client = new TestClient()
      const { status, data } = await client.get<{ status: string }>("/health")
      expect(status).toBe(200)
      expect(data).toEqual({ status: "ok" })
    })

    test("should return readiness payload with pool stats", async () => {
      const client = new TestClient()
      const { status, data } = await client.get<{
        status: string
        timestamp: string
        pools: Array<{ poolName: string }>
      }>("/readyz")

      expect(status).toBe(200)
      expect(data).toMatchObject({
        status: "ok",
        timestamp: expect.any(String),
        pools: expect.any(Array),
      })
    })
  })

  describe("Authentication", () => {
    test("should reject unauthenticated requests", async () => {
      const client = new TestClient()
      const { status } = await client.get("/api/workspaces")
      expect(status).toBe(401)
    })

    test("should login and access protected routes", async () => {
      const client = new TestClient()
      const user = await loginAs(client, testEmail("auth"), "Auth Test User")

      expect(user.id).toMatch(/^workos_test_/)
      expect(user.email).toBe(testEmail("auth"))

      // Verify session works
      const { status, data } = await client.get<{ id: string }>("/api/auth/me")
      expect(status).toBe(200)
      expect(data.id).toBe(user.id)
    })

    test("should maintain session across requests", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("session"), "Session Test")

      // Multiple requests should work
      const r1 = await client.get("/api/auth/me")
      const r2 = await client.get("/api/workspaces")

      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
    })
  })

  describe("Workspaces", () => {
    test("should create and retrieve workspace", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("workspace"), "Workspace Test")

      const workspace = await createWorkspace(client, `Test Workspace ${testRunId}`)

      expect(workspace.id).toMatch(/^ws_/)
      expect(workspace.name).toBe(`Test Workspace ${testRunId}`)
      expect(workspace.slug).toMatch(/^test-workspace-/)

      // Retrieve it
      const { status, data } = await client.get<{ workspace: typeof workspace }>(`/api/workspaces/${workspace.id}`)
      expect(status).toBe(200)
      expect(data.workspace.id).toBe(workspace.id)
    })

    test("should list user workspaces", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("wslist"), "WS List Test")

      await createWorkspace(client, `List Test WS ${testRunId}`)

      const { status, data } = await client.get<{ workspaces: unknown[] }>("/api/workspaces")
      expect(status).toBe(200)
      expect(data.workspaces.length).toBeGreaterThan(0)
    })

    test("should return users and personas in workspace bootstrap", async () => {
      const client = new TestClient()
      const user = await loginAs(client, testEmail("wsboot"), "WS Bootstrap Test")
      const workspace = await createWorkspace(client, `Boot Test WS ${testRunId}`)

      const bootstrap = await getWorkspaceBootstrap(client, workspace.id)

      // Should include the logged-in user as a workspace user
      expect(bootstrap.users).toBeInstanceOf(Array)
      expect(bootstrap.users.length).toBeGreaterThan(0)
      const foundMember = bootstrap.users.find((m) => m.workosUserId === user.id)
      expect(foundMember).toBeDefined()
      expect(foundMember?.name).toBe("WS Bootstrap Test")

      // Should include system personas (Ariadne at minimum)
      expect(bootstrap.personas).toBeInstanceOf(Array)
      expect(bootstrap.personas.length).toBeGreaterThan(0)
      const ariadne = bootstrap.personas.find((p) => p.slug === "ariadne")
      expect(ariadne).toBeDefined()
      expect(ariadne?.managedBy).toBe("system")

      // Stub auth grants the full owner permission set so admin-gated UI is
      // reachable in tests; assert presence rather than the exact list.
      expect(bootstrap.viewerPermissions).toEqual(expect.arrayContaining(["members:write", "workspace:owner"]))
    })
  })

  describe("Scratchpads", () => {
    test("should create scratchpad with companion mode", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("scratchpad"), "Scratchpad Test")
      const workspace = await createWorkspace(client, `SP Test WS ${testRunId}`)

      const scratchpad = await createScratchpad(client, workspace.id, "on")

      expect(scratchpad.id).toMatch(/^stream_/)
      expect(scratchpad.type).toBe("scratchpad")
      // displayName starts null, gets auto-generated from conversation
      expect(scratchpad.displayName).toBeNull()
      expect(scratchpad.companionMode).toBe("on")
    })

    test("should list scratchpads in workspace", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("splist"), "SP List Test")
      const workspace = await createWorkspace(client, `SP List WS ${testRunId}`)

      await createScratchpad(client, workspace.id)
      await createScratchpad(client, workspace.id)

      const streams = await listStreams(client, workspace.id, ["scratchpad"])
      expect(streams.length).toBe(2)
    })

    test("should update companion mode", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("companion"), "Companion Test")
      const workspace = await createWorkspace(client, `Companion WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      expect(scratchpad.companionMode).toBe("off")

      const updated = await updateCompanionMode(client, workspace.id, scratchpad.id, "on")

      expect(updated.companionMode).toBe("on")
    })
  })

  describe("Messages", () => {
    test("should send and retrieve messages", async () => {
      const client = new TestClient()
      const user = await loginAs(client, testEmail("messages"), "Messages Test")
      const workspace = await createWorkspace(client, `Msg WS ${testRunId}`)
      const userId = await getUserId(client, workspace.id, user.id)
      const scratchpad = await createScratchpad(client, workspace.id)

      const message = await sendMessage(client, workspace.id, scratchpad.id, `Hello ${testRunId}!`)

      expect(message.id).toMatch(/^msg_/)
      expect(message.contentMarkdown).toBe(`Hello ${testRunId}!`)
      expect(message.sequence).toBe("1")
      expect(message.authorId).toBe(userId)

      const events = await listEvents(client, workspace.id, scratchpad.id, ["message_created"])
      expect(events.length).toBe(1)
      expect((events[0].payload as { messageId: string }).messageId).toBe(message.id)
      // The events response no longer pre-serializes via serializeBigInt and relies
      // on the app-level json replacer; the bigint sequence must still cross the
      // wire as a string (a raw bigint would 500 in res.json).
      expect(events[0].sequence).toBe("1")
    })

    test("should maintain message sequence", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("sequence"), "Sequence Test")
      const workspace = await createWorkspace(client, `Seq WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)

      const m1 = await sendMessage(client, workspace.id, scratchpad.id, "First")
      const m2 = await sendMessage(client, workspace.id, scratchpad.id, "Second")
      const m3 = await sendMessage(client, workspace.id, scratchpad.id, "Third")

      expect(m1.sequence).toBe("1")
      expect(m2.sequence).toBe("2")
      expect(m3.sequence).toBe("3")
    })

    test("should edit message", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("edit"), "Edit Test")
      const workspace = await createWorkspace(client, `Edit WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "Original content")

      const updated = await updateMessage(client, workspace.id, message.id, "Updated content")

      expect(updated.contentMarkdown).toBe("Updated content")
    })

    test("should not create edit event when content is unchanged", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("edit-noop"), "Edit Noop Test")
      const workspace = await createWorkspace(client, `Edit Noop WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "Same content")

      const updated = await updateMessage(client, workspace.id, message.id, "Same content")

      expect(updated.contentMarkdown).toBe("Same content")
      expect(updated.editedAt).toBeNull()

      const editEvents = await listEvents(client, workspace.id, scratchpad.id, ["message_edited"])
      expect(editEvents).toHaveLength(0)
    })

    test("should delete message", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("delete"), "Delete Test")
      const workspace = await createWorkspace(client, `Del WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "To be deleted")

      await deleteMessage(client, workspace.id, message.id)

      // Verify message_deleted event exists
      const events = await listEvents(client, workspace.id, scratchpad.id, ["message_deleted"])
      const deleteEvent = events.find((e) => (e.payload as { messageId: string }).messageId === message.id)
      expect(deleteEvent).toBeDefined()
    })
  })

  describe("Reactions", () => {
    test("should add reaction to message and store as shortcode", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("reaction-add"), "Reaction Add Test")
      const workspace = await createWorkspace(client, `React Add WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "React to this!")

      // Send raw emoji, expect shortcode in response
      const updated = await addReaction(client, workspace.id, message.id, "👍")

      expect(updated.reactions).toEqual({ ":+1:": [expect.stringMatching(/^usr_/)] })
    })

    test("should accept shortcode input directly", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("reaction-shortcode"), "Reaction Shortcode Test")
      const workspace = await createWorkspace(client, `React SC WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "React with shortcode!")

      // Send shortcode directly
      const updated = await addReaction(client, workspace.id, message.id, ":heart:")

      expect(updated.reactions).toEqual({ ":heart:": [expect.stringMatching(/^usr_/)] })
    })

    test("should remove reaction from message", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("reaction-remove"), "Reaction Remove Test")
      const workspace = await createWorkspace(client, `React Rm WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "React then unreact")

      await addReaction(client, workspace.id, message.id, "❤️")
      // Can remove with raw emoji (normalized to shortcode internally)
      const updated = await removeReaction(client, workspace.id, message.id, "❤️")

      expect(updated.reactions).toEqual({})
    })

    test("should remove reaction using shortcode", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("reaction-rm-sc"), "Reaction Remove SC Test")
      const workspace = await createWorkspace(client, `React RmSC WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "React then unreact with shortcode")

      await addReaction(client, workspace.id, message.id, ":fire:")
      // Remove with shortcode
      const updated = await removeReaction(client, workspace.id, message.id, ":fire:")

      expect(updated.reactions).toEqual({})
    })

    test("should handle multiple reactions from same user", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("reaction-multi"), "Reaction Multi Test")
      const workspace = await createWorkspace(client, `React Multi WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "Multiple reactions")

      await addReaction(client, workspace.id, message.id, "👍")
      const updated = await addReaction(client, workspace.id, message.id, "❤️")

      expect(Object.keys(updated.reactions)).toHaveLength(2)
      expect(updated.reactions[":+1:"]).toHaveLength(1)
      expect(updated.reactions[":heart:"]).toHaveLength(1)
    })

    test("should handle duplicate reaction gracefully", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("reaction-dup"), "Reaction Dup Test")
      const workspace = await createWorkspace(client, `React Dup WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "Duplicate reaction test")

      await addReaction(client, workspace.id, message.id, "🎉")
      const updated = await addReaction(client, workspace.id, message.id, "🎉")

      expect(updated.reactions[":tada:"]).toHaveLength(1)
    })

    test("should handle multiple users reacting with same emoji", async () => {
      const client1 = new TestClient()
      const client2 = new TestClient()

      await loginAs(client1, testEmail("reaction-u1"), "Reaction User 1")
      await loginAs(client2, testEmail("reaction-u2"), "Reaction User 2")

      const workspace = await createWorkspace(client1, `React Users WS ${testRunId}`)
      const scratchpad = await createScratchpad(client1, workspace.id)

      const message = await sendMessage(client1, workspace.id, scratchpad.id, "Multi-user reactions")
      const updated = await addReaction(client1, workspace.id, message.id, "👍")

      expect(updated.reactions[":+1:"]).toHaveLength(1)
      expect(updated.reactions[":+1:"][0]).toMatch(/^usr_/)
    })

    test("should reject invalid emoji", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("reaction-invalid"), "Reaction Invalid Test")
      const workspace = await createWorkspace(client, `React Invalid WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "Invalid reaction test")

      const { status, data } = await client.post<{ error: string }>(
        `/api/workspaces/${workspace.id}/messages/${message.id}/reactions`,
        { emoji: "not-an-emoji" }
      )

      expect(status).toBe(400)
      expect(data.error).toBe("Invalid emoji")
    })

    test("should reject unknown shortcode", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("reaction-unknown"), "Reaction Unknown Test")
      const workspace = await createWorkspace(client, `React Unknown WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "Unknown shortcode test")

      const { status, data } = await client.post<{ error: string }>(
        `/api/workspaces/${workspace.id}/messages/${message.id}/reactions`,
        { emoji: ":not_a_real_shortcode:" }
      )

      expect(status).toBe(400)
      expect(data.error).toBe("Invalid emoji")
    })
  })

  describe("Channels", () => {
    test("should create channel with slug", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("channel-create"), "Channel Create Test")
      const workspace = await createWorkspace(client, `Chan Create WS ${testRunId}`)

      const channel = await createChannel(client, workspace.id, `general-${testRunId}`)

      expect(channel.id).toMatch(/^stream_/)
      expect(channel.type).toBe("channel")
      // Channels use slug as display name, no separate displayName field
      expect(channel.displayName).toBeNull()
      expect(channel.slug).toBe(`general-${testRunId}`)
    })

    test("should create public and private channels", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("channel-vis"), "Channel Visibility Test")
      const workspace = await createWorkspace(client, `Chan Vis WS ${testRunId}`)

      const { status: pubStatus, data: pubData } = await client.post<{
        stream: { visibility: string }
      }>(`/api/workspaces/${workspace.id}/streams`, {
        type: "channel",
        slug: `public-${testRunId}`,
        visibility: "public",
      })
      const { status: privStatus, data: privData } = await client.post<{
        stream: { visibility: string }
      }>(`/api/workspaces/${workspace.id}/streams`, {
        type: "channel",
        slug: `private-${testRunId}`,
        visibility: "private",
      })

      expect(pubStatus).toBe(201)
      expect(privStatus).toBe(201)
      expect(pubData.stream.visibility).toBe("public")
      expect(privData.stream.visibility).toBe("private")
    })

    test("should send messages in channel", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("channel-msg"), "Channel Msg Test")
      const workspace = await createWorkspace(client, `Chan Msg WS ${testRunId}`)
      const channel = await createChannel(client, workspace.id, `msg-channel-${testRunId}`)

      const message = await sendMessage(client, workspace.id, channel.id, "Hello channel!")

      expect(message.contentMarkdown).toBe("Hello channel!")

      const events = await listEvents(client, workspace.id, channel.id, ["message_created"])
      expect(events).toHaveLength(1)
    })

    test("should reject duplicate slug in same workspace", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("channel-dup"), "Channel Dup Test")
      const workspace = await createWorkspace(client, `Chan Dup WS ${testRunId}`)

      await createChannel(client, workspace.id, `announcements-${testRunId}`)

      const { status, data } = await client.post<{ error: string }>(`/api/workspaces/${workspace.id}/streams`, {
        type: "channel",
        slug: `announcements-${testRunId}`,
      })

      expect(status).toBe(409)
      expect(data.error).toContain("already exists")
    })

    test("should reject invalid slug format", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("channel-invalid"), "Channel Invalid Test")
      const workspace = await createWorkspace(client, `Chan Invalid WS ${testRunId}`)

      const { status, data } = await client.post<{
        error: string
        details?: Record<string, string[]>
      }>(`/api/workspaces/${workspace.id}/streams`, {
        type: "channel",
        slug: "Invalid Slug With Spaces",
      })

      expect(status).toBe(400)
      expect(data.error).toBe("Validation failed")
      expect(data.details?.slug?.[0]).toContain("Slug must start with a letter")
    })
  })

  describe("Slug Collision Handling", () => {
    test("should generate unique workspace slugs on collision", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("slug-ws"), "Slug WS Test")

      // Use testRunId to ensure unique names that won't collide with previous runs
      const baseName = `Duplicate WS ${testRunId}`
      const ws1 = await createWorkspace(client, baseName)
      const ws2 = await createWorkspace(client, baseName)

      expect(ws1.slug).toMatch(/^duplicate-ws-/)
      expect(ws2.slug).toBe(`${ws1.slug}-1`)
    })
    // Note: Channel slug collision now returns 409 error instead of auto-generating
    // since channels accept slug directly. See "should reject duplicate slug" test above.
  })

  describe("Error Handling", () => {
    test("should return 401 for unauthenticated requests", async () => {
      const client = new TestClient()
      const { status, data } = await client.get<{ error: string }>("/api/workspaces")

      expect(status).toBe(401)
      expect(data.error).toBe("Not authenticated")
    })

    test("should return 403 when accessing other user's workspace", async () => {
      const client1 = new TestClient()
      const client2 = new TestClient()

      await loginAs(client1, testEmail("err-403-u1"), "Error 403 User 1")
      await loginAs(client2, testEmail("err-403-u2"), "Error 403 User 2")

      const workspace = await createWorkspace(client1, `Private WS ${testRunId}`)

      const { status, data } = await client2.get<{ error: string }>(`/api/workspaces/${workspace.id}`)

      expect(status).toBe(403)
      expect(data.error).toBe("Not a user in this workspace")
    })

    test("should return 403 when accessing stream user is not member of", async () => {
      const client1 = new TestClient()
      const client2 = new TestClient()

      await loginAs(client1, testEmail("err-stream-u1"), "Error Stream User 1")
      await loginAs(client2, testEmail("err-stream-u2"), "Error Stream User 2")

      const workspace = await createWorkspace(client1, `Stream Err WS ${testRunId}`)
      const scratchpad = await createScratchpad(client1, workspace.id)

      // User2 is not a member of workspace, so they get 403 on workspace check first
      const { status, data } = await client2.get<{ error: string }>(
        `/api/workspaces/${workspace.id}/streams/${scratchpad.id}/events`
      )

      expect(status).toBe(403)
      expect(data.error).toBe("Not a user in this workspace")
    })

    test("should return 404 for non-existent workspace", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("err-404-ws"), "Error 404 WS Test")

      const { status, data } = await client.get<{ error: string }>("/api/workspaces/ws_nonexistent123")

      expect(status).toBe(404)
      expect(data.error).toBe("Workspace not found")
    })

    test("should return 404 for non-existent message", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("err-404-msg"), "Error 404 Msg Test")
      const workspace = await createWorkspace(client, `Err 404 Msg WS ${testRunId}`)

      const { status, data } = await client.patch<{ error: string }>(
        `/api/workspaces/${workspace.id}/messages/msg_nonexistent123`,
        { content: "Updated" }
      )

      expect(status).toBe(404)
      expect(data.error).toBe("Message not found")
    })

    test("should return 403 when editing another user's message", async () => {
      const client1 = new TestClient()
      const client2 = new TestClient()

      await loginAs(client1, testEmail("err-edit-u1"), "Error Edit User 1")
      await loginAs(client2, testEmail("err-edit-u2"), "Error Edit User 2")

      const workspace = await createWorkspace(client1, `Edit Err WS ${testRunId}`)
      const scratchpad = await createScratchpad(client1, workspace.id)
      const message = await sendMessage(client1, workspace.id, scratchpad.id, "User 1's message")

      // User 2 tries to edit user 1's message but is not a workspace user
      // so they get 403 on workspace check first
      const { status, data } = await client2.patch<{ error: string }>(
        `/api/workspaces/${workspace.id}/messages/${message.id}`,
        { content: "Trying to edit" }
      )

      expect(status).toBe(403)
      expect(data.error).toBe("Not a user in this workspace")
    })

    test("should return 400 for missing required fields", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("err-400"), "Error 400 Test")

      const { status: wsStatus, data: wsData } = await client.post<{
        error: string
        details?: Record<string, string[]>
      }>("/api/workspaces", {})
      expect(wsStatus).toBe(400)
      expect(wsData.error).toBe("Validation failed")
      expect(wsData.details?.name).toBeDefined()

      const workspace = await createWorkspace(client, `Err 400 WS ${testRunId}`)

      // Channels require slug
      const { status: chStatus, data: chData } = await client.post<{
        error: string
        details?: Record<string, string[]>
      }>(`/api/workspaces/${workspace.id}/streams`, { type: "channel" })
      expect(chStatus).toBe(400)
      expect(chData.error).toBe("Validation failed")
      expect(chData.details?.slug).toBeDefined()

      const scratchpad = await createScratchpad(client, workspace.id)

      // Messages require streamId and content (or contentJson)
      const { status: msgStatus, data: msgData } = await client.post<{
        error: string
        details?: Record<string, string[]>
      }>(`/api/workspaces/${workspace.id}/messages`, { streamId: scratchpad.id })
      expect(msgStatus).toBe(400)
      expect(msgData.error).toBe("Validation failed")
    })
  })

  describe("Slash Commands via Messages", () => {
    test("should dispatch command when first node is a registered command", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("cmd-dispatch"), "Cmd Dispatch Test")
      const workspace = await createWorkspace(client, `Cmd Dispatch WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)

      const contentJson = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "command",
                attrs: { name: "invite", args: "@alice" },
              },
            ],
          },
        ],
      }

      const { status, data } = await client.post<{
        command?: { id: string; name: string; args: string; status: string }
        event?: unknown
      }>(`/api/workspaces/${workspace.id}/messages`, {
        streamId: scratchpad.id,
        contentJson,
      })

      expect(status).toBe(202)
      expect(data.command).toBeDefined()
      expect(data.command!.id).toMatch(/^cmd_/)
      expect(data.command!.name).toBe("invite")
      expect(data.command!.args).toBe("@alice")
      expect(data.command!.status).toBe("dispatched")
      expect(data.event).toBeDefined()
    })

    test("should create message when command is not registered", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("cmd-unreg"), "Cmd Unregistered Test")
      const workspace = await createWorkspace(client, `Cmd Unreg WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)

      const contentJson = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "command",
                attrs: { name: "nonexistent", args: "" },
              },
            ],
          },
        ],
      }

      const { status, data } = await client.post<{ message?: { id: string } }>(
        `/api/workspaces/${workspace.id}/messages`,
        {
          streamId: scratchpad.id,
          contentJson,
        }
      )

      expect(status).toBe(201)
      expect(data.message).toBeDefined()
      expect(data.message!.id).toMatch(/^msg_/)
    })

    test("should create normal message when no command in content", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("cmd-normal"), "Cmd Normal Test")
      const workspace = await createWorkspace(client, `Cmd Normal WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)

      const contentJson = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Hello world" }],
          },
        ],
      }

      const { status, data } = await client.post<{ message?: { id: string } }>(
        `/api/workspaces/${workspace.id}/messages`,
        {
          streamId: scratchpad.id,
          contentJson,
        }
      )

      expect(status).toBe(201)
      expect(data.message).toBeDefined()
      expect(data.message!.id).toMatch(/^msg_/)
    })

    test("should create command_dispatched event not message_created", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("cmd-event"), "Cmd Event Test")
      const workspace = await createWorkspace(client, `Cmd Event WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id)

      const contentJson = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "command",
                attrs: { name: "invite", args: "@alice" },
              },
            ],
          },
        ],
      }

      await client.post(`/api/workspaces/${workspace.id}/messages`, {
        streamId: scratchpad.id,
        contentJson,
      })

      // Should have command_dispatched event, not message_created
      const cmdEvents = await listEvents(client, workspace.id, scratchpad.id, ["command_dispatched"])
      const msgEvents = await listEvents(client, workspace.id, scratchpad.id, ["message_created"])

      expect(cmdEvents.length).toBe(1)
      expect(msgEvents.length).toBe(0)
    })
  })

  describe("Full Flow", () => {
    test("should complete entire user journey", async () => {
      const client = new TestClient()

      // 1. Login
      const user = await loginAs(client, testEmail("journey"), "Journey User")
      expect(user.id).toMatch(/^workos_test_/)

      // 2. Create workspace
      const workspace = await createWorkspace(client, `Journey WS ${testRunId}`)
      expect(workspace.id).toMatch(/^ws_/)

      // 3. Create scratchpad with AI companion
      const scratchpad = await createScratchpad(client, workspace.id, "on")
      expect(scratchpad.companionMode).toBe("on")
      // Display name starts null, gets auto-generated from conversation
      expect(scratchpad.displayName).toBeNull()

      // 4. Send messages
      const m1 = await sendMessage(client, workspace.id, scratchpad.id, "I need to plan my startup")
      const m2 = await sendMessage(client, workspace.id, scratchpad.id, "First step: validate the idea")
      const m3 = await sendMessage(client, workspace.id, scratchpad.id, "Second step: find customers")

      // 5. Verify all messages via events endpoint
      const events = await listEvents(client, workspace.id, scratchpad.id, ["message_created"])
      expect(events.length).toBe(3)

      // 6. Edit a message
      await updateMessage(client, workspace.id, m2.id, "First step: talk to potential customers")

      // 7. Verify edit via message_edited event
      const editEvents = await listEvents(client, workspace.id, scratchpad.id, ["message_edited"])
      expect(editEvents.length).toBe(1)
      const editPayload = editEvents[0].payload as { messageId: string; contentMarkdown: string }
      expect(editPayload.messageId).toBe(m2.id)
      expect(editPayload.contentMarkdown).toBe("First step: talk to potential customers")
    })
  })
})
