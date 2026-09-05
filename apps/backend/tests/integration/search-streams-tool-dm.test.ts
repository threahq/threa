import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threa/types"
import { computeAgentAccessSpec } from "../../src/features/agents"
import { createSearchStreamsTool } from "../../src/features/agents/tools"
import { SearchRepository } from "../../src/features/search"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { UserRepository, WorkspaceRepository } from "../../src/features/workspaces"
import { streamId, userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase, withTestTransaction } from "./setup"

describe("search_streams DM matching", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("matches DM by participant slug and returns viewer-specific DM name", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const peerWorkosUserId = userId()
      const testWorkspaceId = workspaceId()
      const dmId = streamId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Search Streams DM Workspace",
        slug: `search-streams-dm-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: ownerWorkosUserId,
        email: `owner.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "owner-user",
        name: "Owner User",
        role: "owner",
      })
      const peerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: peerWorkosUserId,
        email: `peer.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "peer-user",
        name: "Peer User",
        role: "member",
      })

      await StreamRepository.insert(client, {
        id: dmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, dmId, ownerMember.id)
      await StreamMemberRepository.insert(client, dmId, peerMember.id)

      const ownerTool = createSearchStreamsTool({
        db: client as unknown as Pool,
        workspaceId: testWorkspaceId,
        accessibleStreamIds: [dmId],
        invokingUserId: ownerMember.id,
        searchFlag: "on",
        searchService: {} as never,
        storage: {} as never,
      })

      const ownerResult = await ownerTool.config.execute(
        { query: "Can you summarize my recent DMs with @peer-user" },
        { toolCallId: "owner" }
      )
      const ownerParsed = JSON.parse(ownerResult.output) as {
        results: Array<{ id: string; type: string; name: string }>
      }

      expect(ownerParsed.results).toHaveLength(1)
      expect(ownerParsed.results[0]).toMatchObject({
        id: dmId,
        type: StreamTypes.DM,
        name: "Peer User",
      })

      const peerTool = createSearchStreamsTool({
        db: client as unknown as Pool,
        workspaceId: testWorkspaceId,
        accessibleStreamIds: [dmId],
        invokingUserId: peerMember.id,
        searchFlag: "on",
        searchService: {} as never,
        storage: {} as never,
      })

      const peerResult = await peerTool.config.execute(
        { query: "Summarize my recent DMs with @owner-user" },
        { toolCallId: "peer" }
      )
      const peerParsed = JSON.parse(peerResult.output) as {
        results: Array<{ id: string; type: string; name: string }>
      }

      expect(peerParsed.results).toHaveLength(1)
      expect(peerParsed.results[0]).toMatchObject({
        id: dmId,
        type: StreamTypes.DM,
        name: "Owner User",
      })
    })
  })

  test("scratchpad context grants full user scope and can find DMs by @slug", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const peerWorkosUserId = userId()
      const outsiderWorkosUserId = userId()
      const testWorkspaceId = workspaceId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Scratchpad DM Search Workspace",
        slug: `scratchpad-dm-search-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: ownerWorkosUserId,
        email: `owner.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "owner-user",
        name: "Owner User",
        role: "owner",
      })
      const peerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: peerWorkosUserId,
        email: `peer.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "peer-user",
        name: "Peer User",
        role: "member",
      })
      const outsider = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: outsiderWorkosUserId,
        email: `outsider.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "outsider-user",
        name: "Outsider User",
        role: "member",
      })

      const scratchpadId = streamId()
      await StreamRepository.insert(client, {
        id: scratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
        displayName: "My Scratchpad",
      })
      await StreamMemberRepository.insert(client, scratchpadId, ownerMember.id)

      const dmWithPeerId = streamId()
      await StreamRepository.insert(client, {
        id: dmWithPeerId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, dmWithPeerId, ownerMember.id)
      await StreamMemberRepository.insert(client, dmWithPeerId, peerMember.id)

      const dmWithOutsiderId = streamId()
      await StreamRepository.insert(client, {
        id: dmWithOutsiderId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, dmWithOutsiderId, ownerMember.id)
      await StreamMemberRepository.insert(client, dmWithOutsiderId, outsider.id)

      const otherPrivateScratchpadId = streamId()
      await StreamRepository.insert(client, {
        id: otherPrivateScratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: outsider.id,
        displayName: "Outsider Scratchpad",
      })
      await StreamMemberRepository.insert(client, otherPrivateScratchpadId, outsider.id)

      const scratchpad = await StreamRepository.findById(client, scratchpadId)
      expect(scratchpad).not.toBeNull()

      const accessSpec = await computeAgentAccessSpec(client, {
        stream: scratchpad!,
        invokingUserId: ownerMember.id,
        searchFlag: "on",
      })

      expect(accessSpec.type).toBe("user_full_access")
      const accessibleStreamIds = await SearchRepository.getAccessibleStreamsForAgent(
        client,
        accessSpec,
        testWorkspaceId
      )

      expect(accessibleStreamIds).toContain(dmWithPeerId)
      expect(accessibleStreamIds).toContain(dmWithOutsiderId)
      expect(accessibleStreamIds).not.toContain(otherPrivateScratchpadId)

      const tool = createSearchStreamsTool({
        db: client as unknown as Pool,
        workspaceId: testWorkspaceId,
        accessibleStreamIds,
        invokingUserId: ownerMember.id,
        searchFlag: "on",
        searchService: {} as never,
        storage: {} as never,
      })

      const result = await tool.config.execute(
        { query: "Can you summarize my recent DMs with @peer-user" },
        { toolCallId: "scratchpad" }
      )
      const parsed = JSON.parse(result.output) as {
        results: Array<{ id: string; type: string; name: string }>
      }

      expect(parsed.results.some((stream) => stream.id === dmWithPeerId && stream.name === "Peer User")).toBe(true)
      expect(parsed.results.some((stream) => stream.id === dmWithOutsiderId)).toBe(false)
    })
  })

  test("matches DM by participant name with non-ASCII characters", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const peerWorkosUserId = userId()
      const testWorkspaceId = workspaceId()
      const dmId = streamId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Unicode DM Search Workspace",
        slug: `unicode-dm-search-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: ownerWorkosUserId,
        email: `owner.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "owner-user",
        name: "Owner User",
        role: "owner",
      })
      const unicodePeer = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: peerWorkosUserId,
        email: `accented-peer.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "accented-peer-user",
        name: "Åccént Peer",
        role: "member",
      })

      await StreamRepository.insert(client, {
        id: dmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, dmId, ownerMember.id)
      await StreamMemberRepository.insert(client, dmId, unicodePeer.id)

      const tool = createSearchStreamsTool({
        db: client as unknown as Pool,
        workspaceId: testWorkspaceId,
        accessibleStreamIds: [dmId],
        invokingUserId: ownerMember.id,
        searchFlag: "on",
        searchService: {} as never,
        storage: {} as never,
      })

      const result = await tool.config.execute(
        { query: "Can you summarize my recent DMs with Åccént?" },
        { toolCallId: "unicode" }
      )
      const parsed = JSON.parse(result.output) as {
        results: Array<{ id: string; type: string; name: string }>
      }

      expect(parsed.results).toHaveLength(1)
      expect(parsed.results[0]).toMatchObject({
        id: dmId,
        type: StreamTypes.DM,
        name: "Åccént Peer",
      })
    })
  })

  test("returns no matches for whitespace-only stream search query", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const peerWorkosUserId = userId()
      const testWorkspaceId = workspaceId()
      const dmId = streamId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Empty Query Workspace",
        slug: `empty-query-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: ownerWorkosUserId,
        email: `owner.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "owner-user",
        name: "Owner User",
        role: "owner",
      })
      const peerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: peerWorkosUserId,
        email: `peer.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "peer-user",
        name: "Peer User",
        role: "member",
      })

      await StreamRepository.insert(client, {
        id: dmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, dmId, ownerMember.id)
      await StreamMemberRepository.insert(client, dmId, peerMember.id)

      const tool = createSearchStreamsTool({
        db: client as unknown as Pool,
        workspaceId: testWorkspaceId,
        accessibleStreamIds: [dmId],
        invokingUserId: ownerMember.id,
        searchFlag: "on",
        searchService: {} as never,
        storage: {} as never,
      })

      const result = await tool.config.execute({ query: "   " }, { toolCallId: "empty-query" })
      const parsed = JSON.parse(result.output) as { results: unknown[]; message?: string }

      expect(parsed.results).toEqual([])
      expect(parsed.message).toBe("Search query cannot be empty")
    })
  })

  test("interleaves DM and channel results by relevance so exact DM matches are not dropped", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const peerWorkosUserId = userId()
      const testWorkspaceId = workspaceId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Interleaving Search Workspace",
        slug: `interleaving-search-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: ownerWorkosUserId,
        email: `owner.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "owner-user",
        name: "Owner User",
        role: "owner",
      })
      const testPeer = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: peerWorkosUserId,
        email: `testpeer.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "testy-user",
        name: "Test",
        role: "member",
      })

      const dmId = streamId()
      await StreamRepository.insert(client, {
        id: dmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, dmId, ownerMember.id)
      await StreamMemberRepository.insert(client, dmId, testPeer.id)

      const channelIds: string[] = []
      for (let index = 0; index < 12; index += 1) {
        const channelId = streamId()
        channelIds.push(channelId)
        await StreamRepository.insert(client, {
          id: channelId,
          workspaceId: testWorkspaceId,
          type: StreamTypes.CHANNEL,
          visibility: Visibilities.PUBLIC,
          slug: `test-channel-${index}`,
          displayName: `Test channel ${index}`,
          createdBy: ownerMember.id,
        })
      }

      const tool = createSearchStreamsTool({
        db: client as unknown as Pool,
        workspaceId: testWorkspaceId,
        accessibleStreamIds: [dmId, ...channelIds],
        invokingUserId: ownerMember.id,
        searchFlag: "on",
        searchService: {} as never,
        storage: {} as never,
      })

      const result = await tool.config.execute({ query: "test" }, { toolCallId: "interleave" })
      const parsed = JSON.parse(result.output) as {
        results: Array<{ id: string; type: string; name: string }>
      }

      expect(parsed.results).toHaveLength(10)
      expect(parsed.results[0]).toMatchObject({
        id: dmId,
        type: StreamTypes.DM,
        name: "Test",
      })
    })
  })

  test("listDmPeersForMember fails closed when stream scope is explicitly empty", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const peerWorkosUserId = userId()
      const testWorkspaceId = workspaceId()
      const dmId = streamId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Scoped DM Peers Workspace",
        slug: `scoped-dm-peers-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: ownerWorkosUserId,
        email: `owner.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "owner-user",
        name: "Owner User",
        role: "owner",
      })
      const peerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: peerWorkosUserId,
        email: `peer.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "peer-user",
        name: "Peer User",
        role: "member",
      })

      await StreamRepository.insert(client, {
        id: dmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, dmId, ownerMember.id)
      await StreamMemberRepository.insert(client, dmId, peerMember.id)

      const peers = await StreamRepository.listDmPeersForMember(client, testWorkspaceId, ownerMember.id, {
        streamIds: [],
      })
      expect(peers).toEqual([])
    })
  })

  test("does not return DMs for short substring slugs embedded in other tokens", async () => {
    await withTestTransaction(pool, async (client) => {
      const ownerWorkosUserId = userId()
      const targetPeerWorkosUserId = userId()
      const shortSlugPeerWorkosUserId = userId()
      const testWorkspaceId = workspaceId()

      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "DM Substring Guard Workspace",
        slug: `dm-substring-guard-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })

      const ownerMember = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: ownerWorkosUserId,
        email: `owner.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "owner-user",
        name: "Owner User",
        role: "owner",
      })
      const targetPeer = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: targetPeerWorkosUserId,
        email: `target.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "pierre-boberg",
        name: "Target Peer",
        role: "member",
      })
      const shortSlugPeer = await UserRepository.insert(client, {
        id: userId(),
        workspaceId: testWorkspaceId,
        workosUserId: shortSlugPeerWorkosUserId,
        email: `short.${testWorkspaceId.slice(-6)}@example.com`,
        slug: "bo",
        name: "Bo",
        role: "member",
      })

      const targetDmId = streamId()
      await StreamRepository.insert(client, {
        id: targetDmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, targetDmId, ownerMember.id)
      await StreamMemberRepository.insert(client, targetDmId, targetPeer.id)

      const shortSlugDmId = streamId()
      await StreamRepository.insert(client, {
        id: shortSlugDmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, shortSlugDmId, ownerMember.id)
      await StreamMemberRepository.insert(client, shortSlugDmId, shortSlugPeer.id)

      const tool = createSearchStreamsTool({
        db: client as unknown as Pool,
        workspaceId: testWorkspaceId,
        accessibleStreamIds: [targetDmId, shortSlugDmId],
        invokingUserId: ownerMember.id,
        searchFlag: "on",
        searchService: {} as never,
        storage: {} as never,
      })

      const result = await tool.config.execute(
        { query: "Can you summarize my recent DMs with @pierre-boberg" },
        { toolCallId: "substring-guard" }
      )
      const parsed = JSON.parse(result.output) as {
        results: Array<{ id: string; type: string; name: string }>
      }

      expect(parsed.results.some((entry) => entry.id === targetDmId)).toBe(true)
      expect(parsed.results.some((entry) => entry.id === shortSlugDmId)).toBe(false)
    })
  })
})
