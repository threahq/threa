/**
 * Read-as-owner widens a personal bot's READ access to its owner's reach
 * (INV-62 via the canonical predicate), and nothing else:
 *
 * - threads inherit through the root, so a non-granted thread inside an
 *   owner-member channel is readable (the INV-62 footgun case)
 * - live delegation: the owner losing access revokes the bot's on the very
 *   next call — no snapshot
 * - E2E-rooted streams (and their threads) stay excluded: grant + key-wrap
 *   requirements are the only E2E path
 * - archiving blocks writes, never reads: archived streams (and threads sealed
 *   under them) stay readable through every arm; the actionable tier stays
 *   active-only
 * - shared bots and flag-off personal bots behave exactly as before
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { BotChannelService, BotChannelAccessRepository, isStreamReadableAsOwner } from "../../src/features/api-keys"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { BotRepository } from "../../src/features/public-api"
import { userId, workspaceId, streamId, messageId, botId, botChannelAccessId } from "../../src/lib/id"

const READ_ONLY = {
  accessible: { point: true, listed: true },
  actionable: { point: false, listed: false },
}
const DENIED = {
  accessible: { point: false, listed: false },
  actionable: { point: false, listed: false },
}

describe("read-as-owner access", () => {
  let pool: Pool
  let service: BotChannelService
  let testWorkspaceId: string
  let ownerId: string
  let readerBotId: string
  let plainBotId: string
  let sharedBotId: string
  let privateChannelId: string
  let privateThreadId: string
  let revocableChannelId: string
  let e2eRootId: string
  let e2eThreadId: string
  let archivedChannelId: string
  let archivedRootThreadId: string
  let publicChannelId: string
  let archivedPublicChannelId: string

  async function insertChannel(
    client: Parameters<typeof StreamRepository.insert>[0],
    id: string,
    visibility: string,
    createdBy: string,
    inWorkspaceId = testWorkspaceId
  ) {
    await StreamRepository.insert(client, {
      id,
      workspaceId: inWorkspaceId,
      type: StreamTypes.CHANNEL,
      visibility,
      slug: `s-${id.slice(-10)}`,
      createdBy,
    })
  }

  async function insertThread(client: Parameters<typeof StreamRepository.insert>[0], id: string, rootId: string) {
    await StreamRepository.insert(client, {
      id,
      workspaceId: testWorkspaceId,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PRIVATE,
      parentStreamId: rootId,
      parentAnchorId: messageId(),
      rootStreamId: rootId,
      createdBy: ownerId,
    })
  }

  async function tiers(botIdToUse: string, targetStreamId: string) {
    const [accessiblePoint, accessibleIds, actionablePoint, actionableIds] = await Promise.all([
      service.isStreamAccessibleForBot(testWorkspaceId, botIdToUse, targetStreamId),
      service.getAccessibleStreamIdsForBot(testWorkspaceId, botIdToUse),
      service.isStreamActionableForBot(testWorkspaceId, botIdToUse, targetStreamId),
      service.getActionableStreamIdsForBot(testWorkspaceId, botIdToUse),
    ])
    return {
      accessible: { point: accessiblePoint, listed: accessibleIds.includes(targetStreamId) },
      actionable: { point: actionablePoint, listed: actionableIds.includes(targetStreamId) },
    }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new BotChannelService({ pool })
    testWorkspaceId = workspaceId()
    privateChannelId = streamId()
    privateThreadId = streamId()
    revocableChannelId = streamId()
    e2eRootId = streamId()
    e2eThreadId = streamId()
    archivedChannelId = streamId()
    archivedRootThreadId = streamId()
    publicChannelId = streamId()
    archivedPublicChannelId = streamId()
    readerBotId = botId()
    plainBotId = botId()
    sharedBotId = botId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Read As Owner",
        slug: `read-as-owner-${testWorkspaceId}`,
        createdBy: userId(),
      })
      ownerId = (await addTestMember(client, testWorkspaceId, userId())).id

      await insertChannel(client, privateChannelId, Visibilities.PRIVATE, ownerId)
      await insertThread(client, privateThreadId, privateChannelId)
      await insertChannel(client, revocableChannelId, Visibilities.PRIVATE, ownerId)
      await insertChannel(client, e2eRootId, Visibilities.PRIVATE, ownerId)
      await insertThread(client, e2eThreadId, e2eRootId)
      await insertChannel(client, archivedChannelId, Visibilities.PRIVATE, ownerId)
      await insertThread(client, archivedRootThreadId, archivedChannelId)
      await insertChannel(client, publicChannelId, Visibilities.PUBLIC, ownerId)
      await insertChannel(client, archivedPublicChannelId, Visibilities.PUBLIC, ownerId)
      for (const memberOf of [privateChannelId, revocableChannelId, e2eRootId, archivedChannelId]) {
        await StreamMemberRepository.insert(client, testWorkspaceId, memberOf, ownerId)
      }

      await E2eStreamsRepository.markStreamE2e(client, {
        streamId: e2eRootId,
        workspaceId: testWorkspaceId,
        ownerUserId: ownerId,
        ownerUserKeyId: "e2ek_test",
      })

      await BotRepository.create(client, {
        id: readerBotId,
        workspaceId: testWorkspaceId,
        type: "personal",
        ownerUserId: ownerId,
        readsAsOwner: true,
        slug: "reader-bot",
        name: "Reader",
      })
      await BotRepository.create(client, {
        id: plainBotId,
        workspaceId: testWorkspaceId,
        type: "personal",
        ownerUserId: ownerId,
        slug: "plain-bot",
        name: "Plain",
      })
      await BotRepository.create(client, {
        id: sharedBotId,
        workspaceId: testWorkspaceId,
        type: "shared",
        ownerUserId: null,
        slug: "shared-bot",
        name: "Shared",
      })
    })
    await pool.query(`UPDATE streams SET archived_at = NOW() WHERE id = ANY($1)`, [
      [archivedChannelId, archivedPublicChannelId],
    ])
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should read a private channel and its non-granted thread when the owner is a member", async () => {
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, privateChannelId)).toBe(true)
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, privateThreadId)).toBe(true)

    const ids = await service.getAccessibleStreamIdsForBot(testWorkspaceId, readerBotId)
    expect(ids).toContain(privateChannelId)
    expect(ids).toContain(privateThreadId)
    expect(ids).toContain(publicChannelId)
  })

  test("should deny the same streams to a flag-off personal bot and a shared bot", async () => {
    for (const otherBotId of [plainBotId, sharedBotId]) {
      expect(await service.isStreamAccessibleForBot(testWorkspaceId, otherBotId, privateChannelId)).toBe(false)
      expect(await service.isStreamAccessibleForBot(testWorkspaceId, otherBotId, privateThreadId)).toBe(false)
      const ids = await service.getAccessibleStreamIdsForBot(testWorkspaceId, otherBotId)
      expect(ids).not.toContain(privateChannelId)
      expect(ids).not.toContain(privateThreadId)
      expect(ids).toContain(publicChannelId)
    }
  })

  test("should lose access the moment the owner does — live delegation, not a snapshot", async () => {
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, revocableChannelId)).toBe(true)
    await StreamMemberRepository.delete(pool, testWorkspaceId, revocableChannelId, ownerId)
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, revocableChannelId)).toBe(false)
    expect(await service.getAccessibleStreamIdsForBot(testWorkspaceId, readerBotId)).not.toContain(revocableChannelId)
  })

  test("should exclude an E2E root and its thread from the owner arm, while an explicit grant still works", async () => {
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, e2eRootId)).toBe(false)
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, e2eThreadId)).toBe(false)
    const ids = await service.getAccessibleStreamIdsForBot(testWorkspaceId, readerBotId)
    expect(ids).not.toContain(e2eRootId)
    expect(ids).not.toContain(e2eThreadId)

    // The existing grant + key-wrap path is untouched by the owner arm.
    await BotChannelAccessRepository.grantAccess(pool, {
      id: botChannelAccessId(),
      workspaceId: testWorkspaceId,
      botId: readerBotId,
      streamId: e2eRootId,
      grantedBy: ownerId,
    })
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, e2eRootId)).toBe(true)
  })

  test("should let a read-as-owner bot read an archived private channel and its sealed thread without acting on them", async () => {
    // The thread's own row stays unarchived; only the root's archived_at flips.
    expect({
      channel: await tiers(readerBotId, archivedChannelId),
      thread: await tiers(readerBotId, archivedRootThreadId),
    }).toEqual({ channel: READ_ONLY, thread: READ_ONLY })
  })

  test("should let a granted bot and a shared bot read archived streams they have a claim on without acting on them", async () => {
    await BotChannelAccessRepository.grantAccess(pool, {
      id: botChannelAccessId(),
      workspaceId: testWorkspaceId,
      botId: plainBotId,
      streamId: archivedChannelId,
      grantedBy: ownerId,
    })

    expect({
      grantedChannel: await tiers(plainBotId, archivedChannelId),
      grantedSealedThread: await tiers(plainBotId, archivedRootThreadId),
      sharedPublicChannel: await tiers(sharedBotId, archivedPublicChannelId),
    }).toEqual({ grantedChannel: READ_ONLY, grantedSealedThread: READ_ONLY, sharedPublicChannel: READ_ONLY })
  })

  test("should deny a bot with no claim on an archived private channel", async () => {
    expect({
      archivedChannel: await tiers(sharedBotId, archivedChannelId),
      privateChannel: await tiers(sharedBotId, privateChannelId),
    }).toEqual({ archivedChannel: DENIED, privateChannel: DENIED })
  })

  test("should keep an archived E2E root and its thread out of the owner arm", async () => {
    const root = streamId()
    const thread = streamId()
    await withTransaction(pool, async (client) => {
      await insertChannel(client, root, Visibilities.PRIVATE, ownerId)
      await insertThread(client, thread, root)
      await StreamMemberRepository.insert(client, testWorkspaceId, root, ownerId)
      await E2eStreamsRepository.markStreamE2e(client, {
        streamId: root,
        workspaceId: testWorkspaceId,
        ownerUserId: ownerId,
        ownerUserKeyId: "e2ek_test",
      })
    })
    await pool.query(`UPDATE streams SET archived_at = NOW() WHERE id = $1`, [root])

    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, root)).toBe(false)
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, thread)).toBe(false)
    const ids = await service.getAccessibleStreamIdsForBot(testWorkspaceId, readerBotId)
    expect(ids).not.toContain(root)
    expect(ids).not.toContain(thread)
  })

  test("should deny a nonexistent stream and a stream in another workspace", async () => {
    const foreignWorkspaceId = workspaceId()
    const foreignPublicChannelId = streamId()
    const nonexistentStreamId = streamId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: foreignWorkspaceId,
        name: "Foreign",
        slug: `foreign-${foreignWorkspaceId.slice(-8)}`,
        createdBy: "test",
      })
      await insertChannel(client, foreignPublicChannelId, Visibilities.PUBLIC, "test", foreignWorkspaceId)
    })

    expect({
      nonexistent: {
        ownerArm: await isStreamReadableAsOwner(pool, testWorkspaceId, readerBotId, nonexistentStreamId),
        tiers: await tiers(readerBotId, nonexistentStreamId),
      },
      foreign: {
        ownerArm: await isStreamReadableAsOwner(pool, testWorkspaceId, readerBotId, foreignPublicChannelId),
        tiers: await tiers(readerBotId, foreignPublicChannelId),
      },
    }).toEqual({
      nonexistent: { ownerArm: false, tiers: DENIED },
      foreign: { ownerArm: false, tiers: DENIED },
    })
  })

  test("should stop reading as owner when the flag is turned off", async () => {
    await BotRepository.update(pool, readerBotId, testWorkspaceId, { readsAsOwner: false })
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, privateChannelId)).toBe(false)
    await BotRepository.update(pool, readerBotId, testWorkspaceId, { readsAsOwner: true })
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, privateChannelId)).toBe(true)
  })

  test("should never widen the actionable (participation) tier — delegations gate there", async () => {
    expect(await service.isStreamActionableForBot(testWorkspaceId, readerBotId, privateChannelId)).toBe(false)
    expect(await service.isStreamActionableForBot(testWorkspaceId, readerBotId, privateThreadId)).toBe(false)
    expect(await service.isStreamActionableForBot(testWorkspaceId, readerBotId, publicChannelId)).toBe(true)

    const actionable = await service.getActionableStreamIdsForBot(testWorkspaceId, readerBotId)
    expect(actionable).not.toContain(privateChannelId)
    expect(actionable).not.toContain(privateThreadId)
    expect(actionable).toContain(publicChannelId)
  })

  // Destructive: removes the owner's user row. Keep this last.
  test("should lose every owner-derived read the moment the owner leaves the workspace", async () => {
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, privateChannelId)).toBe(true)
    await pool.query(`DELETE FROM users WHERE workspace_id = $1 AND id = $2`, [testWorkspaceId, ownerId])
    expect(await service.isStreamAccessibleForBot(testWorkspaceId, readerBotId, privateChannelId)).toBe(false)
    expect(await service.getAccessibleStreamIdsForBot(testWorkspaceId, readerBotId)).not.toContain(privateChannelId)
  })
})
