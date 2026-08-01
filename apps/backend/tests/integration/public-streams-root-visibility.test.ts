/**
 * Publicness resolves through the ROOT (INV-62).
 *
 * Threads copy the root's visibility at creation and are never re-synced, so a
 * thread row can say "public" long after its root went private (and vice
 * versa). Every "is this stream public" consumer has to resolve the root —
 * trusting the thread's own row leaked stale-public threads into agent
 * research scopes (`public_only` / `public_plus_stream`) and bot access.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threa/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { SearchRepository } from "../../src/features/search"
import { BotChannelService } from "../../src/features/api-keys"
import { userId, workspaceId, streamId, messageId, botId } from "../../src/lib/id"

describe("public checks resolve the root's visibility", () => {
  let pool: Pool
  let testWorkspaceId: string
  let testUserId: string
  let privatizedRoot: string
  let stalePublicThread: string
  let publicizedRoot: string
  let stalePrivateThread: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    testUserId = userId()
    privatizedRoot = streamId()
    stalePublicThread = streamId()
    publicizedRoot = streamId()
    stalePrivateThread = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Root Visibility",
        slug: `root-vis-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id

      for (const [rootId, threadId, rootVisibility, threadVisibility] of [
        // Born public, thread copied "public", root privatized below.
        [privatizedRoot, stalePublicThread, Visibilities.PUBLIC, Visibilities.PUBLIC],
        // Born private, thread copied "private", root made public below.
        [publicizedRoot, stalePrivateThread, Visibilities.PRIVATE, Visibilities.PRIVATE],
      ] as const) {
        await StreamRepository.insert(client, {
          id: rootId,
          workspaceId: testWorkspaceId,
          type: StreamTypes.CHANNEL,
          visibility: rootVisibility,
          slug: `s-${rootId.slice(-8)}`,
          createdBy: testUserId,
        })
        await StreamRepository.insert(client, {
          id: threadId,
          workspaceId: testWorkspaceId,
          type: StreamTypes.THREAD,
          visibility: threadVisibility,
          parentStreamId: rootId,
          parentAnchorId: messageId(),
          rootStreamId: rootId,
          createdBy: testUserId,
        })
      }
    })

    // The stale-copy premise: only the ROOT's row changes on a visibility
    // flip; the thread keeps whatever it copied at creation.
    await pool.query(`UPDATE streams SET visibility = 'private' WHERE id = $1`, [privatizedRoot])
    await pool.query(`UPDATE streams SET visibility = 'public' WHERE id = $1`, [publicizedRoot])
  })

  afterAll(async () => {
    await pool.end()
  })

  test("getPublicStreams drops a stale-public thread under a privatized root and picks up a stale-private thread under a publicized root", async () => {
    const publicIds = await SearchRepository.getPublicStreams(pool, testWorkspaceId)
    expect(publicIds).not.toContain(stalePublicThread)
    expect(publicIds).not.toContain(privatizedRoot)
    expect(publicIds).toContain(publicizedRoot)
    expect(publicIds).toContain(stalePrivateThread)
  })

  test("bot access to a thread follows the root, not the thread's copied visibility", async () => {
    const service = new BotChannelService({ pool })
    const strangerBot = botId()
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, strangerBot, stalePublicThread)).toBe(false)
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, strangerBot, stalePrivateThread)).toBe(true)
  })
})
