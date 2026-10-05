import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { DM_PARTICIPANT_COUNT, StreamTypes, Visibilities } from "@threahq/types"
import { computeAgentAccessSpec, type AgentAccessSpec } from "../../src/features/agents"
import { AttachmentExtractionRepository, AttachmentRepository } from "../../src/features/attachments"
import { SearchRepository } from "../../src/features/search"
import { isRoomShared, StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { StreamConnectionRepository } from "../../src/features/stream-connections"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { attachmentId, extractionId, streamId, userId, workspaceId } from "../../src/lib/id"
import { streamConnectionId } from "@threahq/backend-common"
import { addTestMember, setupTestDatabase, withTestTransaction } from "./setup"

function makeMalformedUserIntersectionSpec(userIds: string[]): AgentAccessSpec {
  // Intentionally bypass the tuple type to verify the repository still fails closed at runtime.
  return { type: "user_intersection", userIds } as unknown as AgentAccessSpec
}

describe("Agent Access Scope", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("DM agent access intersects participant visibility instead of unioning it", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const secondWorkosUserId = userId()
      const outsiderWorkosUserId = userId()
      const testWorkspaceId = workspaceId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Agent Access Scope Workspace",
        slug: `agent-access-scope-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await addTestMember(client, testWorkspaceId, ownerWorkosUserId)
      const secondMember = await addTestMember(client, testWorkspaceId, secondWorkosUserId)
      const outsiderMember = await addTestMember(client, testWorkspaceId, outsiderWorkosUserId)

      const sharedDmId = streamId()
      const sharedPrivateChannelId = streamId()
      const publicChannelId = streamId()
      const ownerScratchpadId = streamId()
      const secondScratchpadId = streamId()
      const ownerOutsiderDmId = streamId()

      await StreamRepository.insert(client, {
        id: sharedDmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedDmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedDmId, secondMember.id)

      await StreamRepository.insert(client, {
        id: sharedPrivateChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedPrivateChannelId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedPrivateChannelId, secondMember.id)

      await StreamRepository.insert(client, {
        id: publicChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PUBLIC,
        createdBy: ownerMember.id,
      })

      await StreamRepository.insert(client, {
        id: ownerScratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, ownerScratchpadId, ownerMember.id)

      await StreamRepository.insert(client, {
        id: secondScratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: secondMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, secondScratchpadId, secondMember.id)

      await StreamRepository.insert(client, {
        id: ownerOutsiderDmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, ownerOutsiderDmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, ownerOutsiderDmId, outsiderMember.id)

      const sharedDm = await StreamRepository.findById(client, testWorkspaceId, sharedDmId)
      expect(sharedDm).not.toBeNull()

      const accessSpec = await computeAgentAccessSpec(client, {
        stream: sharedDm!,
        invokingUserId: ownerMember.id,
      })

      expect(accessSpec.type).toBe("user_intersection")
      if (accessSpec.type !== "user_intersection") {
        throw new Error(`Expected DM access to use participant intersection, got ${accessSpec.type}`)
      }
      expect(accessSpec.userIds).toHaveLength(2)
      expect(accessSpec.userIds).toEqual(expect.arrayContaining([ownerMember.id, secondMember.id]))

      const accessibleStreamIds = await SearchRepository.getAccessibleStreamsForAgent(
        client,
        accessSpec,
        testWorkspaceId
      )

      expect(new Set(accessibleStreamIds)).toEqual(new Set([sharedDmId, sharedPrivateChannelId, publicChannelId]))
    })
  })

  test("DM agent access resolves threads through their root, not the thread's own row", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const secondWorkosUserId = userId()
      const testWorkspaceId = workspaceId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Agent Thread Scope Workspace",
        slug: `agent-thread-scope-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await addTestMember(client, testWorkspaceId, ownerWorkosUserId)
      const secondMember = await addTestMember(client, testWorkspaceId, secondWorkosUserId)

      const sharedDmId = streamId()
      const ownerOnlyChannelId = streamId()
      const sharedPrivateChannelId = streamId()
      const publicChannelId = streamId()
      const staleVisibilityThreadId = streamId()
      const directMemberThreadId = streamId()
      const sharedChannelThreadId = streamId()
      const publicChannelThreadId = streamId()

      await StreamRepository.insert(client, {
        id: sharedDmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedDmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedDmId, secondMember.id)

      await StreamRepository.insert(client, {
        id: ownerOnlyChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, ownerOnlyChannelId, ownerMember.id)

      await StreamRepository.insert(client, {
        id: sharedPrivateChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedPrivateChannelId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedPrivateChannelId, secondMember.id)

      await StreamRepository.insert(client, {
        id: publicChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PUBLIC,
        createdBy: ownerMember.id,
      })

      const threadUnder = (id: string, rootId: string, visibility: (typeof Visibilities)[keyof typeof Visibilities]) =>
        StreamRepository.insert(client, {
          id,
          workspaceId: testWorkspaceId,
          type: StreamTypes.THREAD,
          visibility,
          parentStreamId: rootId,
          rootStreamId: rootId,
          createdBy: ownerMember.id,
        })

      // Threads copy the root's visibility at creation and are never re-synced:
      // a channel that went private leaves its threads saying "public".
      await threadUnder(staleVisibilityThreadId, ownerOnlyChannelId, Visibilities.PUBLIC)
      // A thread membership row is participation, not access (INV-62).
      await threadUnder(directMemberThreadId, ownerOnlyChannelId, Visibilities.PRIVATE)
      await StreamMemberRepository.insert(client, testWorkspaceId, directMemberThreadId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, directMemberThreadId, secondMember.id)
      await threadUnder(sharedChannelThreadId, sharedPrivateChannelId, Visibilities.PRIVATE)
      await threadUnder(publicChannelThreadId, publicChannelId, Visibilities.PUBLIC)

      const sharedDm = await StreamRepository.findById(client, testWorkspaceId, sharedDmId)
      const accessSpec = await computeAgentAccessSpec(client, {
        stream: sharedDm!,
        invokingUserId: ownerMember.id,
      })

      const accessibleStreamIds = await SearchRepository.getAccessibleStreamsForAgent(
        client,
        accessSpec,
        testWorkspaceId
      )

      expect(new Set(accessibleStreamIds)).toEqual(
        new Set([sharedDmId, sharedPrivateChannelId, publicChannelId, sharedChannelThreadId, publicChannelThreadId])
      )
    })
  })

  test("should read only the shared channel's tree when another workspace reads the room", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const hostId = workspaceId()
      const partnerId = workspaceId()
      for (const id of [hostId, partnerId]) {
        await WorkspaceRepository.insert(client, {
          id,
          name: `Agent shared room ${id}`,
          slug: `agent-shared-room-${id}`,
          createdBy: ownerWorkosUserId,
        })
      }
      const owner = await addTestMember(client, hostId, ownerWorkosUserId)

      const publicChannel = (id: string, workspace = hostId, originWorkspaceId?: string) =>
        StreamRepository.insert(client, {
          id,
          workspaceId: workspace,
          type: StreamTypes.CHANNEL,
          visibility: Visibilities.PUBLIC,
          originWorkspaceId,
          createdBy: owner.id,
        })
      const sharedChannelId = streamId()
      const sharedThreadId = streamId()
      const revokedChannelId = streamId()
      const otherChannelId = streamId()
      const copyId = streamId()
      const partnerOtherChannelId = streamId()
      await publicChannel(sharedChannelId)
      await StreamRepository.insert(client, {
        id: sharedThreadId,
        workspaceId: hostId,
        type: StreamTypes.THREAD,
        visibility: Visibilities.PUBLIC,
        parentStreamId: sharedChannelId,
        rootStreamId: sharedChannelId,
        createdBy: owner.id,
      })
      await publicChannel(revokedChannelId)
      await publicChannel(otherChannelId)
      await publicChannel(copyId, partnerId, hostId)
      await publicChannel(partnerOtherChannelId, partnerId)

      const snapshot = (hostStreamId: string, state: "active" | "revoked") => ({
        id: streamConnectionId(),
        revision: 1,
        state,
        hostWorkspaceId: hostId,
        hostWorkspaceName: "Host",
        hostRegion: "local",
        hostStreamId,
        invitedBy: owner.id,
        partnerWorkspaceId: partnerId,
        partnerWorkspaceName: "Partner",
        partnerRegion: "local",
        partnerVisibility: Visibilities.PUBLIC,
        acceptedBy: null,
        peerWorkspaceIds: [],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      await StreamConnectionRepository.applySnapshots(client, [
        snapshot(sharedChannelId, "active"),
        snapshot(revokedChannelId, "revoked"),
      ])

      const readable = async (workspace: string, roomStreamId: string) => {
        const stream = await StreamRepository.findById(client, workspace, roomStreamId)
        const spec = await computeAgentAccessSpec(client, { stream: stream!, invokingUserId: owner.id })
        return {
          shared: await isRoomShared(client, workspace, roomStreamId),
          streams: new Set(await SearchRepository.getAccessibleStreamsForAgent(client, spec, workspace)),
        }
      }

      expect({
        sharedHost: await readable(hostId, sharedChannelId),
        threadInSharedHost: await readable(hostId, sharedThreadId),
        partnerCopy: await readable(partnerId, copyId),
        revokedShare: await readable(hostId, revokedChannelId),
      }).toEqual({
        sharedHost: { shared: true, streams: new Set([sharedChannelId, sharedThreadId]) },
        threadInSharedHost: { shared: true, streams: new Set([sharedChannelId, sharedThreadId]) },
        partnerCopy: { shared: true, streams: new Set([copyId]) },
        revokedShare: {
          shared: false,
          streams: new Set([sharedChannelId, sharedThreadId, revokedChannelId, otherChannelId]),
        },
      })
    })
  })

  test("DM agent attachment search only returns uploads from shared streams", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const secondWorkosUserId = userId()
      const outsiderWorkosUserId = userId()
      const testWorkspaceId = workspaceId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Agent Attachment Scope Workspace",
        slug: `agent-attachment-scope-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await addTestMember(client, testWorkspaceId, ownerWorkosUserId)
      const secondMember = await addTestMember(client, testWorkspaceId, secondWorkosUserId)
      const outsiderMember = await addTestMember(client, testWorkspaceId, outsiderWorkosUserId)

      const sharedDmId = streamId()
      const sharedPrivateChannelId = streamId()
      const publicChannelId = streamId()
      const ownerScratchpadId = streamId()
      const secondScratchpadId = streamId()
      const ownerOutsiderDmId = streamId()

      await StreamRepository.insert(client, {
        id: sharedDmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedDmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedDmId, secondMember.id)

      await StreamRepository.insert(client, {
        id: sharedPrivateChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedPrivateChannelId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedPrivateChannelId, secondMember.id)

      await StreamRepository.insert(client, {
        id: publicChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PUBLIC,
        createdBy: ownerMember.id,
      })

      await StreamRepository.insert(client, {
        id: ownerScratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, ownerScratchpadId, ownerMember.id)

      await StreamRepository.insert(client, {
        id: secondScratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: secondMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, secondScratchpadId, secondMember.id)

      await StreamRepository.insert(client, {
        id: ownerOutsiderDmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, ownerOutsiderDmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, ownerOutsiderDmId, outsiderMember.id)

      const sharedFilenameAttachmentId = attachmentId()
      const sharedSummaryAttachmentId = attachmentId()
      const sharedFullTextAttachmentId = attachmentId()
      const ownerPrivateAttachmentId = attachmentId()
      const secondPrivateAttachmentId = attachmentId()
      const ownerOutsiderAttachmentId = attachmentId()

      await AttachmentRepository.insert(client, {
        id: sharedFilenameAttachmentId,
        workspaceId: testWorkspaceId,
        streamId: sharedDmId,
        uploadedBy: ownerMember.id,
        filename: "artifact-permission-check-shared-dm.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        storagePath: "uploads/shared-dm.pdf",
      })

      await AttachmentRepository.insert(client, {
        id: sharedSummaryAttachmentId,
        workspaceId: testWorkspaceId,
        streamId: sharedPrivateChannelId,
        uploadedBy: ownerMember.id,
        filename: "shared-channel.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        storagePath: "uploads/shared-channel.png",
      })
      await AttachmentExtractionRepository.insert(client, {
        id: extractionId(),
        attachmentId: sharedSummaryAttachmentId,
        workspaceId: testWorkspaceId,
        contentType: "screenshot",
        summary: "artifact-permission-check summary for a shared channel upload",
      })

      await AttachmentRepository.insert(client, {
        id: sharedFullTextAttachmentId,
        workspaceId: testWorkspaceId,
        streamId: publicChannelId,
        uploadedBy: ownerMember.id,
        filename: "public-channel-notes.txt",
        mimeType: "text/plain",
        sizeBytes: 4096,
        storagePath: "uploads/public-channel-notes.txt",
      })
      await AttachmentExtractionRepository.insert(client, {
        id: extractionId(),
        attachmentId: sharedFullTextAttachmentId,
        workspaceId: testWorkspaceId,
        contentType: "document",
        summary: "Public notes",
        fullText: "artifact-permission-check appears in public channel extracted text",
      })

      await AttachmentRepository.insert(client, {
        id: ownerPrivateAttachmentId,
        workspaceId: testWorkspaceId,
        streamId: ownerScratchpadId,
        uploadedBy: ownerMember.id,
        filename: "owner-private-upload.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        storagePath: "uploads/owner-private.png",
      })
      await AttachmentExtractionRepository.insert(client, {
        id: extractionId(),
        attachmentId: ownerPrivateAttachmentId,
        workspaceId: testWorkspaceId,
        contentType: "screenshot",
        summary: "artifact-permission-check summary from owner private scratchpad",
      })

      await AttachmentRepository.insert(client, {
        id: secondPrivateAttachmentId,
        workspaceId: testWorkspaceId,
        streamId: secondScratchpadId,
        uploadedBy: secondMember.id,
        filename: "artifact-permission-check-second-private.txt",
        mimeType: "text/plain",
        sizeBytes: 1024,
        storagePath: "uploads/second-private.txt",
      })

      await AttachmentRepository.insert(client, {
        id: ownerOutsiderAttachmentId,
        workspaceId: testWorkspaceId,
        streamId: ownerOutsiderDmId,
        uploadedBy: ownerMember.id,
        filename: "owner-outsider-dm.txt",
        mimeType: "text/plain",
        sizeBytes: 1024,
        storagePath: "uploads/owner-outsider-dm.txt",
      })
      await AttachmentExtractionRepository.insert(client, {
        id: extractionId(),
        attachmentId: ownerOutsiderAttachmentId,
        workspaceId: testWorkspaceId,
        contentType: "document",
        summary: "Private DM notes",
        fullText: "artifact-permission-check appears in the owner-outsider DM attachment text",
      })

      const sharedDm = await StreamRepository.findById(client, testWorkspaceId, sharedDmId)
      expect(sharedDm).not.toBeNull()

      const accessSpec = await computeAgentAccessSpec(client, {
        stream: sharedDm!,
        invokingUserId: ownerMember.id,
      })

      const accessibleStreamIds = await SearchRepository.getAccessibleStreamsForAgent(
        client,
        accessSpec,
        testWorkspaceId
      )

      const attachments = await AttachmentRepository.searchWithExtractions(client, {
        workspaceId: testWorkspaceId,
        streamIds: accessibleStreamIds,
        query: "artifact-permission-check",
      })

      expect(new Set(attachments.map((attachment) => attachment.id))).toEqual(
        new Set([sharedFilenameAttachmentId, sharedSummaryAttachmentId, sharedFullTextAttachmentId])
      )
    })
  })

  test("user_intersection fails closed unless constructed with exactly two distinct users", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const secondWorkosUserId = userId()
      const thirdWorkosUserId = userId()
      const testWorkspaceId = workspaceId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Malformed Agent Access Scope Workspace",
        slug: `malformed-agent-access-scope-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await addTestMember(client, testWorkspaceId, ownerWorkosUserId)
      const secondMember = await addTestMember(client, testWorkspaceId, secondWorkosUserId)
      const thirdMember = await addTestMember(client, testWorkspaceId, thirdWorkosUserId)

      const expectedError = `user_intersection access spec requires exactly ${DM_PARTICIPANT_COUNT} distinct users`

      await expect(
        SearchRepository.getAccessibleStreamsForAgent(
          client,
          makeMalformedUserIntersectionSpec([ownerMember.id]),
          testWorkspaceId
        )
      ).rejects.toThrow(expectedError)

      await expect(
        SearchRepository.getAccessibleStreamsForAgent(
          client,
          makeMalformedUserIntersectionSpec([ownerMember.id, ownerMember.id]),
          testWorkspaceId
        )
      ).rejects.toThrow(expectedError)

      await expect(
        SearchRepository.getAccessibleStreamsForAgent(
          client,
          makeMalformedUserIntersectionSpec([ownerMember.id, secondMember.id, thirdMember.id]),
          testWorkspaceId
        )
      ).rejects.toThrow(expectedError)
    })
  })
})
