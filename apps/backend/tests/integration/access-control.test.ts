/**
 * Access Control Integration Tests
 *
 * Tests verify:
 * 1. Workspace membership gates workspace access
 * 2. Stream visibility controls discoverability
 * 3. Private streams require membership
 * 4. Creator-only operations (archive)
 * 5. Member-only operations (companion mode, pin, mute)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository, WorkspaceService } from "../../src/features/workspaces"
import { StreamEventRepository, StreamService, listAccessibleStreamIds } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { SearchRepository } from "../../src/features/search"
import { AttachmentRepository } from "../../src/features/attachments"
import { StreamNotFoundError } from "../../src/lib/errors"
import { setupTestDatabase, testMessageContent } from "./setup"
import { userId, workspaceId, eventId, commandId, attachmentId } from "../../src/lib/id"
import { StreamTypes, Visibilities, AttachmentSafetyStatuses } from "@threa/types"

describe("Access Control", () => {
  let pool: Pool
  let streamService: StreamService
  let workspaceService: WorkspaceService
  let eventService: EventService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    workspaceService = new WorkspaceService(pool, {} as any, {} as any)
    eventService = new EventService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("Workspace Membership", () => {
    test("isMember returns true for workspace users", async () => {
      const user1Id = userId()
      const wsId = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Test Workspace",
          slug: `test-ws-${wsId}`,
          createdBy: user1Id,
        })
        await addTestMember(client, wsId, user1Id)
      })

      const isMember = await workspaceService.isMember(wsId, user1Id)
      expect(isMember).toBe(true)
    })

    test("isMember returns false for non-members", async () => {
      const ownerId = userId()
      const nonMemberId = userId()
      const wsId = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Test Workspace",
          slug: `test-ws-${wsId}`,
          createdBy: ownerId,
        })
      })

      const isMember = await workspaceService.isMember(wsId, nonMemberId)
      expect(isMember).toBe(false)
    })

    test("joining a workspace makes user a member", async () => {
      const ownerId = userId()
      const joiningUserId = userId()
      const wsId = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Test Workspace",
          slug: `test-ws-${wsId}`,
          createdBy: ownerId,
        })
      })

      // Initially not a member
      expect(await workspaceService.isMember(wsId, joiningUserId)).toBe(false)

      // Join the workspace
      await workspaceService.addUser(wsId, {
        workosUserId: joiningUserId,
        email: `joining-user-${joiningUserId}@test.com`,
        name: "Joining User",
      })

      // Now a member
      expect(await workspaceService.isMember(wsId, joiningUserId)).toBe(true)
    })
  })

  describe("Stream Visibility", () => {
    test("public streams are visible to all workspace users", async () => {
      const ownerId = userId()
      const workspaceUserId = userId()
      const wsId = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Public Test Workspace",
          slug: `public-test-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, workspaceUserId)
      })

      // Create a public channel (not adding workspaceUserId as stream member)
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `public-channel-${Date.now()}`,
        displayName: "Public Channel",
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      // Member should be able to access the public stream
      const stream = await streamService.validateStreamAccess(channel.id, wsId, workspaceUserId)
      expect(stream.id).toBe(channel.id)
      expect(stream.visibility).toBe(Visibilities.PUBLIC)
    })

    test("private streams are not visible to non-members", async () => {
      const ownerId = userId()
      const workspaceUserId = userId()
      const wsId = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Private Test Workspace",
          slug: `private-test-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, workspaceUserId)
      })

      // Create a private channel (not adding workspaceUserId as stream member)
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `private-channel-${Date.now()}`,
        displayName: "Private Channel",
        createdBy: ownerId,
        visibility: Visibilities.PRIVATE,
      })

      // Member should NOT be able to access the private stream
      await expect(streamService.validateStreamAccess(channel.id, wsId, workspaceUserId)).rejects.toThrow(
        StreamNotFoundError
      )
    })

    test("private streams are accessible to stream members", async () => {
      const ownerId = userId()
      const streamMemberId = userId()
      const wsId = workspaceId()
      let streamMemberWorkspaceId = ""

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Private Access Workspace",
          slug: `priv-access-ws-${wsId}`,
          createdBy: ownerId,
        })
        streamMemberWorkspaceId = (await addTestMember(client, wsId, streamMemberId)).id
      })

      // Create a private channel
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `private-member-channel-${Date.now()}`,
        displayName: "Private Member Channel",
        createdBy: ownerId,
        visibility: Visibilities.PRIVATE,
      })

      // Add user as stream member
      await streamService.addMember(channel.id, streamMemberWorkspaceId, wsId, ownerId)

      // Now they can access
      const stream = await streamService.validateStreamAccess(channel.id, wsId, streamMemberWorkspaceId)
      expect(stream.id).toBe(channel.id)
    })

    test("scratchpads are always private", async () => {
      const ownerId = userId()
      const otherId = userId()
      const wsId = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Scratchpad Test Workspace",
          slug: `scratch-test-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, otherId)
      })

      // Create a scratchpad
      const scratchpad = await streamService.createScratchpad({
        workspaceId: wsId,
        createdBy: ownerId,
      })

      // Verify it's private
      expect(scratchpad.visibility).toBe(Visibilities.PRIVATE)
      expect(scratchpad.type).toBe(StreamTypes.SCRATCHPAD)

      // Owner can access (they're auto-added as member)
      const ownerAccess = await streamService.validateStreamAccess(scratchpad.id, wsId, ownerId)
      expect(ownerAccess.id).toBe(scratchpad.id)

      // Other workspace user cannot access
      await expect(streamService.validateStreamAccess(scratchpad.id, wsId, otherId)).rejects.toThrow(
        StreamNotFoundError
      )
    })
  })

  describe("Stream Listing", () => {
    test("list returns public streams and user's private streams", async () => {
      const user1Id = userId()
      const user2Id = userId()
      const wsId = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "List Test Workspace",
          slug: `list-test-ws-${wsId}`,
          createdBy: user1Id,
        })
        await addTestMember(client, wsId, user2Id)
      })

      // User 1 creates a public channel
      const publicChannel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `list-public-${Date.now()}`,
        displayName: "Public Channel",
        createdBy: user1Id,
        visibility: Visibilities.PUBLIC,
      })

      // User 1 creates a private scratchpad
      const user1Scratchpad = await streamService.createScratchpad({
        workspaceId: wsId,
        createdBy: user1Id,
      })

      // User 2 creates a private scratchpad
      const user2Scratchpad = await streamService.createScratchpad({
        workspaceId: wsId,
        createdBy: user2Id,
      })

      // User 1's list should include: public channel + their scratchpad
      const user1Streams = await streamService.list(wsId, user1Id)
      const user1StreamIds = user1Streams.map((s) => s.id)
      expect(user1StreamIds).toContain(publicChannel.id)
      expect(user1StreamIds).toContain(user1Scratchpad.id)
      expect(user1StreamIds).not.toContain(user2Scratchpad.id)

      // User 2's list should include: public channel + their scratchpad
      const user2Streams = await streamService.list(wsId, user2Id)
      const user2StreamIds = user2Streams.map((s) => s.id)
      expect(user2StreamIds).toContain(publicChannel.id)
      expect(user2StreamIds).toContain(user2Scratchpad.id)
      expect(user2StreamIds).not.toContain(user1Scratchpad.id)
    })
  })

  describe("Stream Membership Operations", () => {
    test("adding a member grants access to private stream", async () => {
      const ownerId = userId()
      const newMemberId = userId()
      const wsId = workspaceId()
      let newMemberWorkspaceId = ""

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Add Member Workspace",
          slug: `add-member-ws-${wsId}`,
          createdBy: ownerId,
        })
        newMemberWorkspaceId = (await addTestMember(client, wsId, newMemberId)).id
      })

      // Create private channel
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `add-member-channel-${Date.now()}`,
        displayName: "Add Member Channel",
        createdBy: ownerId,
        visibility: Visibilities.PRIVATE,
      })

      // Initially no access
      await expect(streamService.validateStreamAccess(channel.id, wsId, newMemberWorkspaceId)).rejects.toThrow(
        StreamNotFoundError
      )

      // Add as member
      await streamService.addMember(channel.id, newMemberWorkspaceId, wsId, ownerId)

      // Now has access
      const stream = await streamService.validateStreamAccess(channel.id, wsId, newMemberWorkspaceId)
      expect(stream.id).toBe(channel.id)
    })

    test("removing a member revokes access to private stream", async () => {
      const ownerId = userId()
      const removedMemberId = userId()
      const wsId = workspaceId()
      let removedMemberWorkspaceId = ""

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Remove Member Workspace",
          slug: `rm-member-ws-${wsId}`,
          createdBy: ownerId,
        })
        removedMemberWorkspaceId = (await addTestMember(client, wsId, removedMemberId)).id
      })

      // Create private channel with member
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `rm-member-channel-${Date.now()}`,
        displayName: "Remove Member Channel",
        createdBy: ownerId,
        visibility: Visibilities.PRIVATE,
      })
      await streamService.addMember(channel.id, removedMemberWorkspaceId, wsId, ownerId)

      // Verify access
      const accessBefore = await streamService.validateStreamAccess(channel.id, wsId, removedMemberWorkspaceId)
      expect(accessBefore.id).toBe(channel.id)

      // Remove member
      await streamService.removeMember(channel.id, removedMemberWorkspaceId, wsId, ownerId)

      // Access revoked
      await expect(streamService.validateStreamAccess(channel.id, wsId, removedMemberWorkspaceId)).rejects.toThrow(
        StreamNotFoundError
      )
    })
  })

  describe("Cross-Workspace Isolation", () => {
    test("streams in different workspaces are isolated", async () => {
      const user1Id = userId()
      const user2Id = userId()
      const ws1Id = workspaceId()
      const ws2Id = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: ws1Id,
          name: "Workspace 1",
          slug: `ws1-${ws1Id}`,
          createdBy: user1Id,
        })
        await WorkspaceRepository.insert(client, {
          id: ws2Id,
          name: "Workspace 2",
          slug: `ws2-${ws2Id}`,
          createdBy: user2Id,
        })
      })

      // Create stream in workspace 1
      const ws1Stream = await streamService.createChannel({
        workspaceId: ws1Id,
        slug: `ws1-channel-${Date.now()}`,
        displayName: "WS1 Channel",
        createdBy: user1Id,
        visibility: Visibilities.PUBLIC,
      })

      // User 1 can access stream in their workspace
      const access = await streamService.validateStreamAccess(ws1Stream.id, ws1Id, user1Id)
      expect(access.id).toBe(ws1Stream.id)

      // Trying to access with wrong workspace ID fails
      await expect(streamService.validateStreamAccess(ws1Stream.id, ws2Id, user2Id)).rejects.toThrow(
        StreamNotFoundError
      )
    })
  })

  describe("Thread Visibility", () => {
    test("thread inherits visibility from parent channel", async () => {
      const ownerId = userId()
      const workspaceUserId = userId()
      const wsId = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Thread Visibility Workspace",
          slug: `thread-vis-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, workspaceUserId)
      })

      // Create a public channel
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `thread-vis-channel-${Date.now()}`,
        displayName: "Thread Visibility Channel",
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      // Create a message in the channel
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Parent message for thread visibility test"),
      })

      // Create a thread from the channel
      const thread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
        principal: { kind: "user", userId: ownerId },
      })

      // Threads inherit visibility from the root stream.
      expect(thread.visibility).toBe(Visibilities.PUBLIC)
      expect(thread.rootStreamId).toBe(channel.id)

      // Member of workspace (who can see public channel) should be able to access thread
      // via root stream membership check
      const access = await streamService.validateStreamAccess(thread.id, wsId, workspaceUserId)
      expect(access.id).toBe(thread.id)
    })

    test("INV-62: a thread anchored on an EVENT in a public channel is accessible via the root (access is anchor-agnostic)", async () => {
      const ownerId = userId()
      const workspaceUserId = userId() // workspace member, NOT a stream member of the thread
      const wsId = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Event Anchor Visibility Workspace",
          slug: `event-vis-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, workspaceUserId)
      })

      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `event-vis-channel-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      // A threadable card (delegation:created) in the public channel — no message anchor.
      const event = await StreamEventRepository.insert(pool, {
        id: eventId(),
        streamId: channel.id,
        eventType: "delegation:created",
        payload: {},
        actorId: ownerId,
        actorType: "user",
      })

      const thread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: event.id,
        createdBy: ownerId,
        principal: { kind: "user", userId: ownerId },
      })

      expect(thread.parentAnchorId).toBe(event.id)
      expect(thread.visibility).toBe(Visibilities.PUBLIC)

      // The workspace member (never a member of the event-anchored thread) resolves
      // access through the public root — exactly as for a message-anchored thread.
      const access = await streamService.validateStreamAccess(thread.id, wsId, workspaceUserId)
      expect(access.id).toBe(thread.id)
    })

    test("deeply nested threads are visible to root stream members", async () => {
      const ownerId = userId()
      const workspaceUserId = userId()
      const wsId = workspaceId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Deep Thread Workspace",
          slug: `deep-thread-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, workspaceUserId)
      })

      // Create channel -> thread1 -> thread2 -> thread3
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `deep-thread-channel-${Date.now()}`,
        displayName: "Deep Thread Channel",
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      // Create messages for each level
      const msg1 = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Deep message 1"),
      })

      const thread1 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: msg1.id,
        createdBy: ownerId,
        principal: { kind: "user", userId: ownerId },
      })

      const msg2 = await eventService.createMessage({
        workspaceId: wsId,
        streamId: thread1.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Deep message 2"),
      })

      const thread2 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: thread1.id,
        parentAnchorId: msg2.id,
        createdBy: ownerId,
        principal: { kind: "user", userId: ownerId },
      })

      const msg3 = await eventService.createMessage({
        workspaceId: wsId,
        streamId: thread2.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Deep message 3"),
      })

      const thread3 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: thread2.id,
        parentAnchorId: msg3.id,
        createdBy: ownerId,
        principal: { kind: "user", userId: ownerId },
      })

      // All threads should have channel as root
      expect(thread1.rootStreamId).toBe(channel.id)
      expect(thread2.rootStreamId).toBe(channel.id)
      expect(thread3.rootStreamId).toBe(channel.id)

      // Workspace member (with access to public channel) should be able to access deeply nested thread
      const access = await streamService.validateStreamAccess(thread3.id, wsId, workspaceUserId)
      expect(access.id).toBe(thread3.id)
    })

    test("private channel threads require channel membership", async () => {
      const ownerId = userId()
      const nonMemberId = userId()
      const wsId = workspaceId()
      let nonMemberWorkspaceId = ""

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Private Thread Workspace",
          slug: `priv-thread-ws-${wsId}`,
          createdBy: ownerId,
        })
        nonMemberWorkspaceId = (await addTestMember(client, wsId, nonMemberId)).id
      })

      // Create a private channel
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `priv-thread-channel-${Date.now()}`,
        displayName: "Private Thread Channel",
        createdBy: ownerId,
        visibility: Visibilities.PRIVATE,
      })

      // Create a message in the channel
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Private channel message for thread"),
      })

      // Create a thread
      const thread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
        principal: { kind: "user", userId: ownerId },
      })

      // Non-member of channel cannot access thread (even though in workspace)
      await expect(streamService.validateStreamAccess(thread.id, wsId, nonMemberWorkspaceId)).rejects.toThrow(
        StreamNotFoundError
      )

      // Add them to channel
      await streamService.addMember(channel.id, nonMemberWorkspaceId, wsId, ownerId)

      // Now they can access thread
      const access = await streamService.validateStreamAccess(thread.id, wsId, nonMemberWorkspaceId)
      expect(access.id).toBe(thread.id)
    })

    test("channel member can post to thread via isMember inheritance", async () => {
      const channelOwnerId = userId()
      const channelMemberId = userId()
      const threadCreatorId = userId() // e.g., a persona
      const wsId = workspaceId()
      let channelMemberWorkspaceId = ""

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Thread isMember Workspace",
          slug: `thread-ismember-ws-${wsId}`,
          createdBy: channelOwnerId,
        })
        channelMemberWorkspaceId = (await addTestMember(client, wsId, channelMemberId)).id
        await addTestMember(client, wsId, threadCreatorId)
      })

      // Create channel with owner and member
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `thread-ismember-channel-${Date.now()}`,
        createdBy: channelOwnerId,
        visibility: Visibilities.PRIVATE,
      })
      await streamService.addMember(channel.id, channelMemberWorkspaceId, wsId, channelOwnerId)

      // Create message and thread by a different user (e.g., persona creating thread for mention response)
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: channelMemberWorkspaceId,
        authorType: "user",
        ...testMessageContent("Message that will spawn a thread"),
      })
      const thread = await streamService.createThreadInternal({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: threadCreatorId,
      })

      // Channel member should be able to post to thread even without direct thread membership
      // This is the exact scenario: user mentions @ariadne, ariadne creates thread, user should be able to respond
      expect(await streamService.isMember(thread.id, channelMemberWorkspaceId)).toBe(true)
      expect(await streamService.isMember(thread.id, channelOwnerId)).toBe(true)
    })

    test("adding member to thread adds them to root stream", async () => {
      const ownerId = userId()
      const newMemberId = userId()
      const wsId = workspaceId()
      let newMemberWorkspaceId = ""

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Thread Add Member Workspace",
          slug: `thread-add-member-ws-${wsId}`,
          createdBy: ownerId,
        })
        newMemberWorkspaceId = (await addTestMember(client, wsId, newMemberId)).id
      })

      // Create a private channel and thread
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `thread-add-member-channel-${Date.now()}`,
        displayName: "Thread Add Member Channel",
        createdBy: ownerId,
        visibility: Visibilities.PRIVATE,
      })

      // Create a message in the channel
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Message for add member to thread test"),
      })

      const thread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
        principal: { kind: "user", userId: ownerId },
      })

      // Initially not a member of either
      expect(await streamService.isMember(channel.id, newMemberWorkspaceId)).toBe(false)
      expect(await streamService.isMember(thread.id, newMemberWorkspaceId)).toBe(false)

      // Add them to the thread
      await streamService.addMember(thread.id, newMemberWorkspaceId, wsId, ownerId)

      // Should now be member of both thread AND root channel
      expect(await streamService.isMember(thread.id, newMemberWorkspaceId)).toBe(true)
      expect(await streamService.isMember(channel.id, newMemberWorkspaceId)).toBe(true)
    })
  })

  describe("Member-Only Operations", () => {
    test("isMember correctly identifies stream members", async () => {
      const ownerId = userId()
      const workspaceUserId = userId()
      const nonMemberId = userId()
      const wsId = workspaceId()
      let memberWorkspaceId = ""
      let nonMemberWorkspaceId = ""

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "isMember Test Workspace",
          slug: `is-member-ws-${wsId}`,
          createdBy: ownerId,
        })
        memberWorkspaceId = (await addTestMember(client, wsId, workspaceUserId)).id
        nonMemberWorkspaceId = (await addTestMember(client, wsId, nonMemberId)).id
      })

      // Create channel and add workspaceUserId
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `is-member-channel-${Date.now()}`,
        displayName: "isMember Channel",
        createdBy: ownerId,
        visibility: Visibilities.PRIVATE,
      })
      await streamService.addMember(channel.id, memberWorkspaceId, wsId, ownerId)

      // Owner is member (auto-added on create)
      expect(await streamService.isMember(channel.id, ownerId)).toBe(true)

      // Explicitly added member is member
      expect(await streamService.isMember(channel.id, memberWorkspaceId)).toBe(true)

      // Non-member is not member
      expect(await streamService.isMember(channel.id, nonMemberWorkspaceId)).toBe(false)
    })
  })

  describe("Command Event Visibility", () => {
    test("command events are only visible to the command author", async () => {
      const userAId = userId()
      const userBId = userId()
      const wsId = workspaceId()
      let userBMemberId = ""

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Command Visibility Workspace",
          slug: `cmd-vis-ws-${wsId}`,
          createdBy: userAId,
        })
        userBMemberId = (await addTestMember(client, wsId, userBId)).id
      })

      // Create a public channel with both users as members
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `cmd-vis-channel-${Date.now()}`,
        displayName: "Command Visibility Channel",
        createdBy: userAId,
        visibility: Visibilities.PUBLIC,
      })
      await streamService.addMember(channel.id, userBMemberId, wsId, userAId)

      // Create a regular message (visible to both)
      await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: userAId,
        authorType: "user",
        ...testMessageContent("Regular message visible to all"),
      })

      // Create command events as User A (directly via repository for test control)
      const cmdId = commandId()
      await withTransaction(pool, async (client) => {
        await StreamEventRepository.insert(client, {
          id: eventId(),
          streamId: channel.id,
          eventType: "command_dispatched",
          payload: {
            commandId: cmdId,
            name: "invite",
            args: "test args",
            status: "dispatched",
          },
          actorId: userAId,
          actorType: "user",
        })

        await StreamEventRepository.insert(client, {
          id: eventId(),
          streamId: channel.id,
          eventType: "command_completed",
          payload: {
            commandId: cmdId,
            result: "test result",
          },
          actorId: userAId,
          actorType: "user",
        })
      })

      // User A should see all events including command events
      const userAEvents = await eventService.listEvents(channel.id, { viewerId: userAId })
      const userAEventTypes = userAEvents.map((e) => e.eventType)
      expect(userAEventTypes).toContain("message_created")
      expect(userAEventTypes).toContain("command_dispatched")
      expect(userAEventTypes).toContain("command_completed")

      // User B should only see message events, NOT command events
      const userBEvents = await eventService.listEvents(channel.id, { viewerId: userBId })
      const userBEventTypes = userBEvents.map((e) => e.eventType)
      expect(userBEventTypes).toContain("message_created")
      expect(userBEventTypes).not.toContain("command_dispatched")
      expect(userBEventTypes).not.toContain("command_completed")
    })

    test("command_failed events are only visible to the command author", async () => {
      const userAId = userId()
      const userBId = userId()
      const wsId = workspaceId()
      let userBMemberId = ""

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Command Failed Visibility Workspace",
          slug: `cmd-fail-vis-ws-${wsId}`,
          createdBy: userAId,
        })
        userBMemberId = (await addTestMember(client, wsId, userBId)).id
      })

      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `cmd-fail-vis-channel-${Date.now()}`,
        displayName: "Command Failed Visibility Channel",
        createdBy: userAId,
        visibility: Visibilities.PUBLIC,
      })
      await streamService.addMember(channel.id, userBMemberId, wsId, userAId)

      // Create command_dispatched and command_failed events as User A
      const cmdId = commandId()
      await withTransaction(pool, async (client) => {
        await StreamEventRepository.insert(client, {
          id: eventId(),
          streamId: channel.id,
          eventType: "command_dispatched",
          payload: {
            commandId: cmdId,
            name: "invite",
            args: "bad args",
            status: "dispatched",
          },
          actorId: userAId,
          actorType: "user",
        })

        await StreamEventRepository.insert(client, {
          id: eventId(),
          streamId: channel.id,
          eventType: "command_failed",
          payload: {
            commandId: cmdId,
            error: "Something went wrong",
          },
          actorId: userAId,
          actorType: "user",
        })
      })

      // User A should see failed command events
      const userAEvents = await eventService.listEvents(channel.id, { viewerId: userAId })
      const userAEventTypes = userAEvents.map((e) => e.eventType)
      expect(userAEventTypes).toContain("command_dispatched")
      expect(userAEventTypes).toContain("command_failed")

      // User B should NOT see failed command events
      const userBEvents = await eventService.listEvents(channel.id, { viewerId: userBId })
      const userBEventTypes = userBEvents.map((e) => e.eventType)
      expect(userBEventTypes).not.toContain("command_dispatched")
      expect(userBEventTypes).not.toContain("command_failed")
    })
  })

  /**
   * INV-62: stream access is inherited via thread → root, and membership ≠
   * access. These cases pin the SQL-side predicate
   * (`streamAccessPredicateSql`, now the single definition shared by
   * `listAccessibleStreamIds`, the search repo, and the attachment explorer
   * search) against the three scenarios the inlined copies used to get
   * wrong, on each cross-cutting surface:
   *   (a) a thread inside a channel the viewer is a member of (but not a
   *       member of the thread itself) IS visible;
   *   (b) a public channel the viewer is NOT a member of IS visible;
   *   (c) a private channel the viewer is NOT a member of is NOT visible.
   */
  describe("Thread → root SQL access predicate (INV-62)", () => {
    /**
     * Builds one workspace containing, for a viewer who is ONLY a member of
     * `memberPrivateChannel`:
     *   - memberThread: a thread inside that private channel (viewer is NOT a
     *     thread member) → must be visible via root inheritance
     *   - publicChannel: a public channel the viewer is not a member of →
     *     visible
     *   - otherPrivateChannel: a private channel the viewer is not a member of
     *     → not visible
     */
    async function buildFixture() {
      const ownerId = userId()
      const wsId = workspaceId()
      let viewerId = ""

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "INV-62 Predicate Workspace",
          slug: `inv62-ws-${wsId}`,
          createdBy: ownerId,
        })
        viewerId = (await addTestMember(client, wsId, userId())).id
      })

      const memberPrivateChannel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `inv62-member-private-${Date.now()}`,
        displayName: "Member Private Channel",
        createdBy: ownerId,
        visibility: Visibilities.PRIVATE,
      })
      await streamService.addMember(memberPrivateChannel.id, viewerId, wsId, ownerId)

      // Thread inside the member channel; viewer is NOT added to the thread.
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: memberPrivateChannel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Parent message spawning a thread"),
      })
      const memberThread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: memberPrivateChannel.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
        principal: { kind: "user", userId: ownerId },
      })

      const publicChannel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `inv62-public-${Date.now()}`,
        displayName: "Public Channel",
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      const otherPrivateChannel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `inv62-other-private-${Date.now()}`,
        displayName: "Other Private Channel",
        createdBy: ownerId,
        visibility: Visibilities.PRIVATE,
      })

      return {
        wsId,
        viewerId,
        memberThread,
        publicChannel,
        otherPrivateChannel,
      }
    }

    test("listAccessibleStreamIds resolves all three cases through the shared predicate", async () => {
      const { wsId, viewerId, memberThread, publicChannel, otherPrivateChannel } = await buildFixture()

      const accessible = await listAccessibleStreamIds(pool, wsId, viewerId, [
        memberThread.id,
        publicChannel.id,
        otherPrivateChannel.id,
      ])

      expect(accessible.has(memberThread.id)).toBe(true)
      expect(accessible.has(publicChannel.id)).toBe(true)
      expect(accessible.has(otherPrivateChannel.id)).toBe(false)
    })

    test("workspace listings include inherited threads without exposing private roots", async () => {
      const { wsId, viewerId, memberThread, publicChannel, otherPrivateChannel } = await buildFixture()

      const [listed, withPreviews] = await Promise.all([
        streamService.list(wsId, viewerId),
        streamService.listWithPreviews(wsId, viewerId),
      ])

      for (const streams of [listed, withPreviews]) {
        const ids = new Set(streams.map((stream) => stream.id))
        expect(ids.has(memberThread.id)).toBe(true)
        expect(ids.has(publicChannel.id)).toBe(true)
        expect(ids.has(otherPrivateChannel.id)).toBe(false)
      }
    })

    test("search accessible-stream gating resolves all three cases", async () => {
      const { wsId, viewerId, memberThread, publicChannel, otherPrivateChannel } = await buildFixture()

      const accessibleIds = await SearchRepository.getAccessibleStreamsWithMembers(pool, {
        workspaceId: wsId,
        userId: viewerId,
      })
      const accessible = new Set(accessibleIds)

      expect(accessible.has(memberThread.id)).toBe(true)
      expect(accessible.has(publicChannel.id)).toBe(true)
      expect(accessible.has(otherPrivateChannel.id)).toBe(false)
    })

    test("attachment explorer search returns uploads from a thread inside a member channel and from a public channel, never from a private non-member channel", async () => {
      const { wsId, viewerId, memberThread, publicChannel, otherPrivateChannel } = await buildFixture()
      const ownerId = userId()

      // One clean, message-linked attachment per stream. They share a common
      // filename token so a single name-substring search would surface every
      // accessible one; gating, not text matching, is what's under test.
      const nameToken = `inv62token${Date.now()}`
      const seedAttachment = async (streamIdValue: string, tag: string): Promise<string> => {
        const attId = attachmentId()
        await withTransaction(pool, async (client) => {
          // The explorer search requires message_id IS NOT NULL; create a
          // message in the stream and point the attachment at it.
          const { message } = await eventService.createMessageInTransaction(client, {
            workspaceId: wsId,
            streamId: streamIdValue,
            authorId: ownerId,
            authorType: "user",
            ...testMessageContent(`attachment carrier ${tag}`),
          })
          await AttachmentRepository.insert(client, {
            id: attId,
            workspaceId: wsId,
            streamId: streamIdValue,
            uploadedBy: ownerId,
            filename: `${nameToken}-${tag}.pdf`,
            mimeType: "application/pdf",
            sizeBytes: 1024,
            storagePath: `/test/${nameToken}-${tag}`,
            safetyStatus: AttachmentSafetyStatuses.CLEAN,
          })
          await client.query(`UPDATE attachments SET message_id = $1 WHERE id = $2`, [message.id, attId])
        })
        return attId
      }

      const threadAttachmentId = await seedAttachment(memberThread.id, "thread")
      const publicAttachmentId = await seedAttachment(publicChannel.id, "public")
      const privateAttachmentId = await seedAttachment(otherPrivateChannel.id, "private")

      const results = await withTransaction(pool, (client) =>
        AttachmentRepository.search(client, {
          workspaceId: wsId,
          userId: viewerId,
          nameSubstring: nameToken,
          limit: 50,
        })
      )
      const foundIds = new Set(results.map((r) => r.id))

      expect(foundIds.has(threadAttachmentId)).toBe(true)
      expect(foundIds.has(publicAttachmentId)).toBe(true)
      expect(foundIds.has(privateAttachmentId)).toBe(false)
    })
  })
})
