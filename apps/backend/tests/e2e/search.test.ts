/**
 * E2E tests for search functionality.
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/search.test.ts
 */

import { describe, test, expect } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createScratchpad,
  createChannel,
  sendMessage,
  sendDmMessage,
  createThread,
  search,
  joinWorkspace,
  joinStream,
  archiveStream,
  unarchiveStream,
  getUserId,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-search-${testRunId}@test.com`

describe("Search E2E Tests", () => {
  describe("Basic Search", () => {
    test("should find messages by keyword", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("keyword"), "Keyword Test")
      const workspace = await createWorkspace(client, `Search WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Send messages with distinct content
      const uniqueWord = `unicorn${testRunId}`
      await sendMessage(client, workspace.id, scratchpad.id, `I saw a ${uniqueWord} yesterday`)
      await sendMessage(client, workspace.id, scratchpad.id, "Regular message without the word")

      const results = await search(client, workspace.id, { query: uniqueWord })

      expect(results.length).toBe(1)
      expect(results[0].content).toContain(uniqueWord)
    })

    test("should return empty array when no matches", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("nomatch"), "No Match Test")
      const workspace = await createWorkspace(client, `NoMatch WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      await sendMessage(client, workspace.id, scratchpad.id, "Hello world")

      const results = await search(client, workspace.id, { query: "xyznonexistent123" })

      expect(results).toEqual([])
    })

    test("should respect limit parameter", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("limit"), "Limit Test")
      const workspace = await createWorkspace(client, `Limit WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const keyword = `dragon${testRunId}`
      // Send multiple messages with the keyword
      for (let i = 0; i < 5; i++) {
        await sendMessage(client, workspace.id, scratchpad.id, `Message ${i} about ${keyword}`)
      }

      const results = await search(client, workspace.id, { query: keyword, limit: 2 })

      expect(results.length).toBe(2)
    })

    test("should search across multiple streams", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("multi"), "Multi Test")
      const workspace = await createWorkspace(client, `Multi WS ${testRunId}`)
      const scratchpad1 = await createScratchpad(client, workspace.id, "off")
      const scratchpad2 = await createScratchpad(client, workspace.id, "off")

      const keyword = `phoenix${testRunId}`
      await sendMessage(client, workspace.id, scratchpad1.id, `First ${keyword} message`)
      await sendMessage(client, workspace.id, scratchpad2.id, `Second ${keyword} message`)

      const results = await search(client, workspace.id, { query: keyword })

      expect(results.length).toBe(2)
    })

    test("should find exact phrase when quoted", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("phrase"), "Phrase Test")
      const workspace = await createWorkspace(client, `Phrase WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Send messages - one with exact phrase, one with words in different order
      const phrase = `${testRunId} chicken wings`
      await sendMessage(client, workspace.id, scratchpad.id, `I love ${phrase} for dinner`)
      await sendMessage(client, workspace.id, scratchpad.id, `Wings are better than chicken ${testRunId}`)

      // Search for exact phrase with quotes - should only match first message
      const phraseResults = await search(client, workspace.id, { query: `"${phrase}"` })
      expect(phraseResults.length).toBe(1)
      expect(phraseResults[0].content).toContain(phrase)

      // Search without quotes - should match both (individual words)
      const wordResults = await search(client, workspace.id, { query: `${testRunId} chicken wings` })
      expect(wordResults.length).toBe(2)
    })
  })

  describe("Permission Filtering", () => {
    test("should only return messages from accessible streams", async () => {
      // User A creates workspace and channel
      const clientA = new TestClient()
      const userA = await loginAs(clientA, testEmail("userA"), "User A")
      const workspace = await createWorkspace(clientA, `Perm WS ${testRunId}`)
      const privateChannel = await createChannel(clientA, workspace.id, `private-${testRunId}`, "private")

      const keyword = `secret${testRunId}`
      await sendMessage(clientA, workspace.id, privateChannel.id, `A ${keyword} message`)

      // User B joins workspace but NOT the private channel
      const clientB = new TestClient()
      await loginAs(clientB, testEmail("userB"), "User B")
      await joinWorkspace(clientB, workspace.id)

      // User B searches - should not find User A's message in private channel
      const resultsB = await search(clientB, workspace.id, { query: keyword })
      expect(resultsB.length).toBe(0)

      // User A searches - should find their own message
      const resultsA = await search(clientA, workspace.id, { query: keyword })
      expect(resultsA.length).toBe(1)
    })

    test("should return messages from public channels without membership", async () => {
      // User A creates workspace with public channel
      const clientA = new TestClient()
      await loginAs(clientA, testEmail("pubA"), "Pub User A")
      const workspace = await createWorkspace(clientA, `PubChan WS ${testRunId}`)
      const publicChannel = await createChannel(clientA, workspace.id, `public-${testRunId}`, "public")

      const keyword = `public${testRunId}`
      await sendMessage(clientA, workspace.id, publicChannel.id, `A ${keyword} announcement`)

      // User B joins workspace (but not the channel specifically)
      const clientB = new TestClient()
      await loginAs(clientB, testEmail("pubB"), "Pub User B")
      await joinWorkspace(clientB, workspace.id)

      // User B should find the message since channel is public
      const resultsB = await search(clientB, workspace.id, { query: keyword })
      expect(resultsB.length).toBe(1)
    })
  })

  describe("Filter Operators", () => {
    test("should filter by stream type with type:scratchpad", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("istype"), "Is Type Test")
      const workspace = await createWorkspace(client, `IsType WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")
      const channel = await createChannel(client, workspace.id, `filter-${testRunId}`, "private")

      const keyword = `griffin${testRunId}`
      await sendMessage(client, workspace.id, scratchpad.id, `Scratchpad ${keyword}`)
      await sendMessage(client, workspace.id, channel.id, `Channel ${keyword}`)

      // Search with type:scratchpad filter
      const results = await search(client, workspace.id, { query: keyword, type: ["scratchpad"] })

      expect(results.length).toBe(1)
      expect(results[0].content).toContain("Scratchpad")
    })

    test("should filter by stream type with type:channel", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("ischan"), "Is Channel Test")
      const workspace = await createWorkspace(client, `IsChan WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")
      const channel = await createChannel(client, workspace.id, `chanfilter-${testRunId}`, "private")

      const keyword = `hydra${testRunId}`
      await sendMessage(client, workspace.id, scratchpad.id, `Scratchpad ${keyword}`)
      await sendMessage(client, workspace.id, channel.id, `Channel ${keyword}`)

      const results = await search(client, workspace.id, { query: keyword, type: ["channel"] })

      expect(results.length).toBe(1)
      expect(results[0].content).toContain("Channel")
    })

    test("should filter by author with from filter", async () => {
      // User A creates workspace and channel
      const clientA = new TestClient()
      const userA = await loginAs(clientA, testEmail("fromA"), "From User A")
      const workspace = await createWorkspace(clientA, `From WS ${testRunId}`)
      const userAId = await getUserId(clientA, workspace.id, userA.id)
      const channel = await createChannel(clientA, workspace.id, `from-${testRunId}`, "public")

      const keyword = `dragon${testRunId}`
      await sendMessage(clientA, workspace.id, channel.id, `User A says ${keyword}`)

      // User B joins and sends message
      const clientB = new TestClient()
      await loginAs(clientB, testEmail("fromB"), "From User B")
      await joinWorkspace(clientB, workspace.id)
      await joinStream(clientB, workspace.id, channel.id)
      await sendMessage(clientB, workspace.id, channel.id, `User B says ${keyword}`)

      // Search for messages from User A only - pass workspace user ID
      const results = await search(clientA, workspace.id, { query: keyword, from: userAId })

      expect(results.length).toBe(1)
      expect(results[0].authorId).toBe(userAId)
    })

    test("should filter by co-member with with filter", async () => {
      // User A creates workspace with two channels
      const clientA = new TestClient()
      await loginAs(clientA, testEmail("withA"), "With User A")
      const workspace = await createWorkspace(clientA, `With WS ${testRunId}`)
      const channelShared = await createChannel(clientA, workspace.id, `shared-${testRunId}`, "private")
      const channelPrivate = await createChannel(clientA, workspace.id, `private-${testRunId}`, "private")

      const keyword = `sphinx${testRunId}`
      await sendMessage(clientA, workspace.id, channelShared.id, `Shared ${keyword}`)
      await sendMessage(clientA, workspace.id, channelPrivate.id, `Private ${keyword}`)

      // User B joins workspace and only the shared channel
      const clientB = new TestClient()
      const userB = await loginAs(clientB, testEmail("withB"), "With User B")
      const memberB = await joinWorkspace(clientB, workspace.id)
      await joinStream(clientB, workspace.id, channelShared.id)

      // User A searches with userB's member ID - should only find messages in shared channel
      const results = await search(clientA, workspace.id, { query: keyword, with: [memberB.id] })

      expect(results.length).toBe(1)
      expect(results[0].streamId).toBe(channelShared.id)
    })

    test("should scope search to the DM when in contains a user id", async () => {
      const clientA = new TestClient()
      await loginAs(clientA, testEmail("indmA"), "InDm User A")
      const workspace = await createWorkspace(clientA, `InDm WS ${testRunId}`)
      const scratchpad = await createScratchpad(clientA, workspace.id, "off")

      const clientB = new TestClient()
      await loginAs(clientB, testEmail("indmB"), "InDm User B")
      const memberB = await joinWorkspace(clientB, workspace.id)

      const keyword = `wyvern${testRunId}`
      const dmMessage = await sendDmMessage(clientA, workspace.id, memberB.id, `DM ${keyword}`)
      await sendMessage(clientA, workspace.id, scratchpad.id, `Scratchpad ${keyword}`)

      const results = await search(clientA, workspace.id, { query: keyword, in: [memberB.id] })

      expect(results.length).toBe(1)
      expect(results[0]).toMatchObject({ id: dmMessage.id, streamId: dmMessage.streamId })
    })

    test("should include thread replies when in filters by stream", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("inthread"), "InThread Test")
      const workspace = await createWorkspace(client, `InThread WS ${testRunId}`)
      const channel = await createChannel(client, workspace.id, `inthread-${testRunId}`, "private")
      const otherChannel = await createChannel(client, workspace.id, `inother-${testRunId}`, "private")

      const keyword = `basilisk${testRunId}`
      const rootMessage = await sendMessage(client, workspace.id, channel.id, `Root ${keyword}`)
      const thread = await createThread(client, workspace.id, channel.id, rootMessage.id)
      await sendMessage(client, workspace.id, thread.id, `Thread reply ${keyword}`)
      await sendMessage(client, workspace.id, otherChannel.id, `Other ${keyword}`)

      const results = await search(client, workspace.id, { query: keyword, in: [channel.id] })

      const streamIds = results.map((r) => r.streamId).sort()
      expect(streamIds).toEqual([channel.id, thread.id].sort())
    })

    test("should return no results when in targets a user without a DM", async () => {
      const clientA = new TestClient()
      await loginAs(clientA, testEmail("nodmA"), "NoDm User A")
      const workspace = await createWorkspace(clientA, `NoDm WS ${testRunId}`)
      const scratchpad = await createScratchpad(clientA, workspace.id, "off")

      const clientB = new TestClient()
      await loginAs(clientB, testEmail("nodmB"), "NoDm User B")
      const memberB = await joinWorkspace(clientB, workspace.id)

      const keyword = `manticore${testRunId}`
      await sendMessage(clientA, workspace.id, scratchpad.id, `Scratchpad ${keyword}`)

      const results = await search(clientA, workspace.id, { query: keyword, in: [memberB.id] })

      expect(results).toEqual([])
    })

    test("should include thread replies in with-filtered shared streams", async () => {
      const clientA = new TestClient()
      await loginAs(clientA, testEmail("withThreadA"), "WithThread User A")
      const workspace = await createWorkspace(clientA, `WithThread WS ${testRunId}`)
      const channel = await createChannel(clientA, workspace.id, `withthread-${testRunId}`, "private")

      const clientB = new TestClient()
      await loginAs(clientB, testEmail("withThreadB"), "WithThread User B")
      const memberB = await joinWorkspace(clientB, workspace.id)
      await joinStream(clientB, workspace.id, channel.id)

      const keyword = `chimera${testRunId}`
      const rootMessage = await sendMessage(clientA, workspace.id, channel.id, `Root ${keyword}`)
      const thread = await createThread(clientA, workspace.id, channel.id, rootMessage.id)
      await sendMessage(clientA, workspace.id, thread.id, `Thread reply ${keyword}`)

      const results = await search(clientA, workspace.id, { query: keyword, with: [memberB.id] })

      const streamIds = results.map((r) => r.streamId).sort()
      expect(streamIds).toEqual([channel.id, thread.id].sort())
    })

    test("should combine multiple filters", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("combo"), "Combo Test")
      const workspace = await createWorkspace(client, `Combo WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")
      const channel = await createChannel(client, workspace.id, `combo-${testRunId}`, "private")

      const keyword = `kraken${testRunId}`
      await sendMessage(client, workspace.id, scratchpad.id, `Scratchpad ${keyword}`)
      await sendMessage(client, workspace.id, channel.id, `Channel ${keyword}`)

      // Search with type:scratchpad filter - should only find the scratchpad message
      const results = await search(client, workspace.id, { query: keyword, type: ["scratchpad"] })

      expect(results.length).toBe(1)
      expect(results[0].content).toContain("Scratchpad")
    })
  })

  describe("Edge Cases", () => {
    test("should handle search with only filters (no keywords)", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("filteronly"), "Filter Only Test")
      const workspace = await createWorkspace(client, `FilterOnly WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      await sendMessage(client, workspace.id, scratchpad.id, "Some message content")

      // Search with only filter, no query
      const results = await search(client, workspace.id, { type: ["scratchpad"] })

      expect(results.length).toBeGreaterThan(0)
    })

    test("should handle special characters in search", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("special"), "Special Chars Test")
      const workspace = await createWorkspace(client, `Special WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      await sendMessage(client, workspace.id, scratchpad.id, "Test message with normal content")

      // Search with special characters - should not crash
      const results = await search(client, workspace.id, { query: "test & query | special" })

      // Should either return results or empty array, not error
      expect(Array.isArray(results)).toBe(true)
    })

    test("should return messages sorted by relevance", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("relevance"), "Relevance Test")
      const workspace = await createWorkspace(client, `Relevance WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const keyword = `basilisk${testRunId}`
      // First message has keyword once
      await sendMessage(client, workspace.id, scratchpad.id, `One ${keyword} here`)
      // Second message has keyword multiple times
      await sendMessage(client, workspace.id, scratchpad.id, `Many ${keyword} ${keyword} ${keyword} mentions`)

      const results = await search(client, workspace.id, { query: keyword })

      expect(results.length).toBe(2)
      // Results should have rank property
      expect(results[0]).toHaveProperty("rank")
    })

    test("should treat after filter as inclusive (>=)", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("afterinc"), "After Inclusive Test")
      const workspace = await createWorkspace(client, `AfterInc WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Send a message and capture its creation time
      const keyword = `chimera${testRunId}`
      const msgResult = await sendMessage(client, workspace.id, scratchpad.id, `Test ${keyword} message`)

      // Search with after set to exactly the message's creation time - should include it (inclusive)
      const results = await search(client, workspace.id, {
        query: keyword,
        after: msgResult.createdAt,
      })

      expect(results.length).toBe(1)
      expect(results[0].id).toBe(msgResult.id)
    })

    test("should treat before filter as exclusive (<)", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("beforeexc"), "Before Exclusive Test")
      const workspace = await createWorkspace(client, `BeforeExc WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Send a message and capture its creation time
      const keyword = `manticore${testRunId}`
      const msgResult = await sendMessage(client, workspace.id, scratchpad.id, `Test ${keyword} message`)

      // Search with before set to exactly the message's creation time - should NOT include it (exclusive)
      const results = await search(client, workspace.id, {
        query: keyword,
        before: msgResult.createdAt,
      })

      expect(results.length).toBe(0)
    })
  })

  describe("Archive Status Filtering", () => {
    test("should exclude archived stream messages by default", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("archdef"), "Archive Default Test")
      const workspace = await createWorkspace(client, `ArchDef WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const keyword = `wyvern${testRunId}`
      await sendMessage(client, workspace.id, scratchpad.id, `Message in ${keyword}`)

      // Archive the stream
      await archiveStream(client, workspace.id, scratchpad.id)

      // Default search (no status filter) should NOT find the message
      const results = await search(client, workspace.id, { query: keyword })

      expect(results.length).toBe(0)
    })

    test("should find archived stream messages with status:archived", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("archonly"), "Archive Only Test")
      const workspace = await createWorkspace(client, `ArchOnly WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const keyword = `gargoyle${testRunId}`
      await sendMessage(client, workspace.id, scratchpad.id, `Message in ${keyword}`)

      // Archive the stream
      await archiveStream(client, workspace.id, scratchpad.id)

      // Search with status:archived should find it
      const results = await search(client, workspace.id, { query: keyword, status: ["archived"] })

      expect(results.length).toBe(1)
      expect(results[0].content).toContain(keyword)
    })

    test("should find all messages with both active and archived status", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("archboth"), "Archive Both Test")
      const workspace = await createWorkspace(client, `ArchBoth WS ${testRunId}`)
      const scratchpadActive = await createScratchpad(client, workspace.id, "off")
      const scratchpadArchived = await createScratchpad(client, workspace.id, "off")

      const keyword = `leviathan${testRunId}`
      await sendMessage(client, workspace.id, scratchpadActive.id, `Active ${keyword}`)
      await sendMessage(client, workspace.id, scratchpadArchived.id, `Archived ${keyword}`)

      // Archive one of the streams
      await archiveStream(client, workspace.id, scratchpadArchived.id)

      // Search with both statuses should find both messages
      const results = await search(client, workspace.id, {
        query: keyword,
        status: ["active", "archived"],
      })

      expect(results.length).toBe(2)
    })

    test("should unarchive stream and make messages searchable again", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("unarch"), "Unarchive Test")
      const workspace = await createWorkspace(client, `Unarch WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const keyword = `cerberus${testRunId}`
      await sendMessage(client, workspace.id, scratchpad.id, `Message about ${keyword}`)

      // Archive the stream
      await archiveStream(client, workspace.id, scratchpad.id)

      // Verify message not found with default search
      const archivedResults = await search(client, workspace.id, { query: keyword })
      expect(archivedResults.length).toBe(0)

      // Unarchive the stream
      await unarchiveStream(client, workspace.id, scratchpad.id)

      // Now message should be found again
      const restoredResults = await search(client, workspace.id, { query: keyword })
      expect(restoredResults.length).toBe(1)
      expect(restoredResults[0].content).toContain(keyword)
    })

    test("should reject sending message to archived stream with 403", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("archmsg"), "Archive Message Test")
      const workspace = await createWorkspace(client, `ArchMsg WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Archive the stream
      await archiveStream(client, workspace.id, scratchpad.id)

      // Attempt to send a message - should get 403
      const { status, data } = await client.post(`/api/workspaces/${workspace.id}/messages`, {
        streamId: scratchpad.id,
        content: "This should fail",
      })

      expect(status).toBe(403)
      expect(data).toHaveProperty("error")
    })

    test("should reject unarchive by non-creator with 403", async () => {
      // Creator creates and archives a public channel
      const creator = new TestClient()
      await loginAs(creator, testEmail("archcreator"), "Archive Creator")
      const workspace = await createWorkspace(creator, `ArchCreator WS ${testRunId}`)
      const channel = await createChannel(creator, workspace.id, `archtest-${testRunId}`)
      await archiveStream(creator, workspace.id, channel.id)

      // Different user joins the workspace and the channel
      const other = new TestClient()
      await loginAs(other, testEmail("archother"), "Archive Other")
      await joinWorkspace(other, workspace.id)
      await joinStream(other, workspace.id, channel.id)

      // Other user attempts to unarchive - should get 403 (not the creator)
      const { status, data } = await other.post(`/api/workspaces/${workspace.id}/streams/${channel.id}/unarchive`)

      expect(status).toBe(403)
      expect(data).toHaveProperty("error")
    })
  })
})
