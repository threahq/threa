/**
 * The hybrid legs' recall ceiling against the real schema (INV-68). Each leg
 * fetches `SEARCH_HYBRID_LEG_LIMIT` rows before RRF fusion, so a match beyond
 * that is unreachable at any requested limit — the statement has to run for the
 * claim to mean anything.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupIsolatedTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { SearchRepository, SEARCH_HYBRID_LEG_LIMIT } from "../../src/features/search"
import { streamId, userId, workspaceId } from "../../src/lib/id"

/** One more than the old hardcoded 50, so the test fails on a regression to it. */
const MATCHING_MESSAGES = 51

describe("Hybrid search leg limit", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  const wsId = workspaceId()
  let padId: string

  beforeAll(async () => {
    ;({ pool, cleanup } = await setupIsolatedTestDatabase("hybrid_leg_limit"))

    let memberId = ""
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Leg Limit WS",
        slug: `leg-limit-${wsId}`,
        createdBy: userId(),
      })
      memberId = (await addTestMember(client, wsId, userId())).id
      padId = streamId()
      await StreamRepository.insert(client, {
        id: padId,
        workspaceId: wsId,
        type: "scratchpad",
        visibility: "private",
        companionMode: "off",
        createdBy: memberId,
      })
      await StreamMemberRepository.insert(client, padId, memberId)
    })

    const events = new EventService(pool)
    for (let i = 0; i < MATCHING_MESSAGES; i++) {
      await events.createMessage({
        workspaceId: wsId,
        streamId: padId,
        authorId: memberId,
        authorType: "user",
        ...testMessageContent(`rollbackmarker note number ${i}`),
      })
    }
  }, 60_000)

  afterAll(async () => {
    await cleanup()
  }, 30_000)

  test("the keyword leg reaches past the old 50-row cap", async () => {
    expect(SEARCH_HYBRID_LEG_LIMIT).toBeGreaterThanOrEqual(MATCHING_MESSAGES)

    const results = await SearchRepository.hybridSearch(pool, {
      query: "rollbackmarker",
      embedding: new Array(1536).fill(0),
      streamIds: [padId],
      filters: {},
      limit: MATCHING_MESSAGES,
      ranking: "improved",
      keywordWeight: 0.4,
      semanticWeight: 0.6,
    })

    expect(results).toHaveLength(MATCHING_MESSAGES)
  })

  test("a caller asking for more rows than the leg limit still gets legs that deep", async () => {
    const results = await SearchRepository.hybridSearch(pool, {
      query: "rollbackmarker",
      embedding: new Array(1536).fill(0),
      streamIds: [padId],
      filters: {},
      limit: SEARCH_HYBRID_LEG_LIMIT + 100,
      ranking: "improved",
      keywordWeight: 0.4,
      semanticWeight: 0.6,
    })

    expect(results).toHaveLength(MATCHING_MESSAGES)
  })
})
