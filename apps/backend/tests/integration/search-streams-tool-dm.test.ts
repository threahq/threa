import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { computeAgentAccessSpec } from "../../src/features/agents"
import { createSearchStreamsTool, type SearchStreamsInput } from "../../src/features/agents/tools"
import { SearchRepository } from "../../src/features/search"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { UserRepository, WorkspaceRepository } from "../../src/features/workspaces"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase, testMessageContent, withTestTransaction } from "./setup"

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
      await StreamMemberRepository.insert(client, testWorkspaceId, dmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, dmId, peerMember.id)

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
      await StreamMemberRepository.insert(client, testWorkspaceId, scratchpadId, ownerMember.id)

      const dmWithPeerId = streamId()
      await StreamRepository.insert(client, {
        id: dmWithPeerId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, dmWithPeerId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, dmWithPeerId, peerMember.id)

      const dmWithOutsiderId = streamId()
      await StreamRepository.insert(client, {
        id: dmWithOutsiderId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, dmWithOutsiderId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, dmWithOutsiderId, outsider.id)

      const otherPrivateScratchpadId = streamId()
      await StreamRepository.insert(client, {
        id: otherPrivateScratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: outsider.id,
        displayName: "Outsider Scratchpad",
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, otherPrivateScratchpadId, outsider.id)

      const scratchpad = await StreamRepository.findById(client, testWorkspaceId, scratchpadId)
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
      await StreamMemberRepository.insert(client, testWorkspaceId, dmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, dmId, unicodePeer.id)

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

  test("browses accessible streams when the query is whitespace-only", async () => {
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
      await StreamMemberRepository.insert(client, testWorkspaceId, dmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, dmId, peerMember.id)

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
      const parsed = JSON.parse(result.output) as { results: Array<{ id: string; type: string; name: string }> }

      expect(parsed.results).toEqual([expect.objectContaining({ id: dmId, type: StreamTypes.DM, name: "Peer User" })])
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
      await StreamMemberRepository.insert(client, testWorkspaceId, dmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, dmId, testPeer.id)

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
      await StreamMemberRepository.insert(client, testWorkspaceId, dmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, dmId, peerMember.id)

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
      await StreamMemberRepository.insert(client, testWorkspaceId, targetDmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, targetDmId, targetPeer.id)

      const shortSlugDmId = streamId()
      await StreamRepository.insert(client, {
        id: shortSlugDmId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.DM,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerMember.id,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, shortSlugDmId, ownerMember.id)
      await StreamMemberRepository.insert(client, testWorkspaceId, shortSlugDmId, shortSlugPeer.id)

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

describe("search_streams archive handling", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seedArchiveScenario(client: PoolClient) {
    const testWorkspaceId = workspaceId()
    const workosUserId = userId()
    await WorkspaceRepository.insert(client, {
      id: testWorkspaceId,
      name: "Archived Streams Workspace",
      slug: `archived-streams-${testWorkspaceId}`,
      createdBy: workosUserId,
    })
    const owner = await UserRepository.insert(client, {
      id: userId(),
      workspaceId: testWorkspaceId,
      workosUserId,
      email: `owner.${testWorkspaceId.slice(-6)}@example.com`,
      slug: "owner-user",
      name: "Owner User",
      role: "owner",
    })
    const dmPeer = await UserRepository.insert(client, {
      id: userId(),
      workspaceId: testWorkspaceId,
      workosUserId: userId(),
      email: `zephyrine.${testWorkspaceId.slice(-6)}@example.com`,
      slug: "zephyrine-quill",
      name: "Zephyrine Quill",
      role: "member",
    })

    const insertStream = async (
      type: typeof StreamTypes.CHANNEL | typeof StreamTypes.SYSTEM | typeof StreamTypes.DM,
      slug: string | null,
      archived: boolean
    ) => {
      const id = streamId()
      await StreamRepository.insert(client, {
        id,
        workspaceId: testWorkspaceId,
        type,
        visibility: type === StreamTypes.CHANNEL ? Visibilities.PUBLIC : Visibilities.PRIVATE,
        ...(slug && { slug, displayName: slug }),
        createdBy: owner.id,
      })
      if (archived) await StreamRepository.update(client, testWorkspaceId, id, { archivedAt: new Date() })
      return id
    }

    const activeChannelId = await insertStream(StreamTypes.CHANNEL, "vendor-operations", false)
    const archivedChannelId = await insertStream(StreamTypes.CHANNEL, "vendor-ops", true)
    const inaccessibleArchivedChannelId = await insertStream(StreamTypes.CHANNEL, "vendor-secret", true)
    const systemStreamId = await insertStream(StreamTypes.SYSTEM, null, false)
    const archivedDmId = await insertStream(StreamTypes.DM, null, true)
    await StreamMemberRepository.insert(client, testWorkspaceId, archivedDmId, owner.id)
    await StreamMemberRepository.insert(client, testWorkspaceId, archivedDmId, dmPeer.id)

    const sealedThreadId = streamId()
    await StreamRepository.insert(client, {
      id: sealedThreadId,
      workspaceId: testWorkspaceId,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PUBLIC,
      parentStreamId: archivedChannelId,
      rootStreamId: archivedChannelId,
      createdBy: owner.id,
    })

    const tool = createSearchStreamsTool({
      db: client,
      workspaceId: testWorkspaceId,
      accessibleStreamIds: [activeChannelId, archivedChannelId, sealedThreadId, systemStreamId, archivedDmId],
      invokingUserId: owner.id,
      searchFlag: "on",
      searchService: {} as never,
      storage: {} as never,
    })
    const run = async (input: SearchStreamsInput) => {
      const result = await tool.config.execute(input, { toolCallId: "archive" })
      return (JSON.parse(result.output) as { results: Array<{ id: string; name: string; archived?: boolean }> }).results
    }
    const flagsById = (results: Array<{ id: string; archived?: boolean }>) =>
      new Map(results.map((r) => [r.id, r.archived]))

    return {
      testWorkspaceId,
      ownerId: owner.id,
      activeChannelId,
      archivedChannelId,
      inaccessibleArchivedChannelId,
      systemStreamId,
      archivedDmId,
      sealedThreadId,
      run,
      flagsById,
    }
  }

  test("lists recent streams with archived ones flagged when no query is given", async () => {
    await withTestTransaction(pool, async (client) => {
      const {
        activeChannelId,
        archivedChannelId,
        inaccessibleArchivedChannelId,
        systemStreamId,
        archivedDmId,
        run,
        flagsById,
      } = await seedArchiveScenario(client)

      const results = await run({})

      expect(flagsById(results)).toEqual(
        new Map([
          [activeChannelId, undefined],
          [archivedChannelId, true],
          [archivedDmId, true],
        ])
      )
      expect(results.map((r) => r.id)).not.toContain(inaccessibleArchivedChannelId)
      expect(results.map((r) => r.id)).not.toContain(systemStreamId)
    })
  })

  test("lists only the archived channels and DMs when archived is only", async () => {
    await withTestTransaction(pool, async (client) => {
      const { archivedChannelId, archivedDmId, run, flagsById } = await seedArchiveScenario(client)

      expect(flagsById(await run({ archived: "only" }))).toEqual(
        new Map([
          [archivedChannelId, true],
          [archivedDmId, true],
        ])
      )
    })
  })

  test("lists the sealed thread flagged when types names threads and archived is only", async () => {
    await withTestTransaction(pool, async (client) => {
      const { sealedThreadId, run, flagsById } = await seedArchiveScenario(client)

      expect(flagsById(await run({ types: [StreamTypes.THREAD], archived: "only" }))).toEqual(
        new Map([[sealedThreadId, true]])
      )
    })
  })

  test("omits archived streams and sealed threads when archived is exclude", async () => {
    await withTestTransaction(pool, async (client) => {
      const { activeChannelId, run } = await seedArchiveScenario(client)

      expect((await run({ archived: "exclude" })).map((r) => r.id)).toEqual([activeChannelId])
      expect(await run({ types: [StreamTypes.THREAD], archived: "exclude" })).toEqual([])
    })
  })

  test("browses by newest message rather than stream creation when the older channel has newer activity", async () => {
    await withTestTransaction(pool, async (client) => {
      const { testWorkspaceId, ownerId, activeChannelId, archivedChannelId, run } = await seedArchiveScenario(client)
      await MessageRepository.insert(client, {
        workspaceId: testWorkspaceId,
        id: messageId(),
        streamId: activeChannelId,
        sequence: 1n,
        authorId: ownerId,
        authorType: "user",
        createdAt: new Date(Date.now() + 60_000),
        ...testMessageContent("recent activity"),
      })

      const results = await run({ types: [StreamTypes.CHANNEL] })

      expect(results.map((r) => r.id)).toEqual([activeChannelId, archivedChannelId])
    })
  })

  test("returns an archived channel marked archived and ranks it after an active match when a name query matches both", async () => {
    await withTestTransaction(pool, async (client) => {
      const { activeChannelId, archivedChannelId, run } = await seedArchiveScenario(client)

      const results = await run({ query: "vendor", types: [StreamTypes.CHANNEL] })

      expect(results.map((r) => [r.id, r.archived ?? false])).toEqual([
        [activeChannelId, false],
        [archivedChannelId, true],
      ])
    })
  })

  test("filters name matches by archived state", async () => {
    await withTestTransaction(pool, async (client) => {
      const { activeChannelId, archivedChannelId, run, flagsById } = await seedArchiveScenario(client)

      expect(flagsById(await run({ query: "vendor", types: [StreamTypes.CHANNEL], archived: "only" }))).toEqual(
        new Map([[archivedChannelId, true]])
      )
      expect(flagsById(await run({ query: "vendor", types: [StreamTypes.CHANNEL], archived: "exclude" }))).toEqual(
        new Map([[activeChannelId, undefined]])
      )
    })
  })

  test("finds an archived DM by the peer's name and marks it archived", async () => {
    await withTestTransaction(pool, async (client) => {
      const { archivedDmId, run } = await seedArchiveScenario(client)

      expect(await run({ query: "Zephyrine" })).toEqual([
        expect.objectContaining({ id: archivedDmId, name: "Zephyrine Quill", archived: true }),
      ])
      expect((await run({ query: "Zephyrine", archived: "only" })).map((r) => r.id)).toEqual([archivedDmId])
      expect(await run({ query: "Zephyrine", archived: "exclude" })).toEqual([])
    })
  })

  test("lists an archived DM under the peer's name when browsing DMs", async () => {
    await withTestTransaction(pool, async (client) => {
      const { archivedDmId, run } = await seedArchiveScenario(client)

      expect(await run({ types: [StreamTypes.DM] })).toEqual([
        expect.objectContaining({ id: archivedDmId, name: "Zephyrine Quill", archived: true }),
      ])
    })
  })
})
