/**
 * A reads-as-owner bot's WRITE to a stream it can read but was never added to
 * is a truthful terminal 403 (READ_ONLY / not_a_member), not the
 * existence-hiding 404 — an agent that just read the stream must not be told
 * "not found". Existence hiding survives everywhere the bot cannot read:
 * flag-off personal bots, shared bots, E2E-rooted roots, archived streams.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { HttpError } from "@threa/backend-common"
import { StreamTypes, Visibilities } from "@threa/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { assertStreamWritable, StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { BotRepository } from "../../src/features/public-api"
import { StreamNotFoundError } from "../../src/lib/errors"
import { userId, workspaceId, streamId, botId, botChannelAccessId } from "../../src/lib/id"

describe("read-as-owner write authority", () => {
  let pool: Pool
  let testWorkspaceId: string
  let ownerId: string
  let readerBotId: string
  let plainBotId: string
  let sharedBotId: string
  let privateChannelId: string
  let grantedChannelId: string
  let e2eChannelId: string
  let archivedChannelId: string
  let archivedRootThreadId: string

  async function expectHidden404(promise: Promise<unknown>) {
    const error = (await promise.then(
      () => {
        throw new Error("expected the write to be rejected")
      },
      (err: unknown) => err
    )) as HttpError
    expect(error).toBeInstanceOf(StreamNotFoundError)
    expect({ status: error.status, code: error.code }).toEqual({ status: 404, code: "STREAM_NOT_FOUND" })
  }

  function writeAs(botIdToUse: string, targetStreamId: string) {
    return withTransaction(pool, (client) =>
      assertStreamWritable(client, {
        workspaceId: testWorkspaceId,
        streamId: targetStreamId,
        principal: { kind: "bot", botId: botIdToUse },
      })
    )
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    privateChannelId = streamId()
    grantedChannelId = streamId()
    e2eChannelId = streamId()
    archivedChannelId = streamId()
    archivedRootThreadId = streamId()
    readerBotId = botId()
    plainBotId = botId()
    sharedBotId = botId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "RAO Write",
        slug: `rao-write-${testWorkspaceId}`,
        createdBy: userId(),
      })
      ownerId = (await addTestMember(client, testWorkspaceId, userId())).id

      for (const id of [privateChannelId, grantedChannelId, e2eChannelId, archivedChannelId]) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: testWorkspaceId,
          type: StreamTypes.CHANNEL,
          visibility: Visibilities.PRIVATE,
          slug: `s-${id.slice(-10)}`,
          createdBy: ownerId,
        })
        await StreamMemberRepository.insert(client, id, ownerId)
      }

      await StreamRepository.insert(client, {
        id: archivedRootThreadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.THREAD,
        visibility: Visibilities.PRIVATE,
        parentStreamId: archivedChannelId,
        parentAnchorId: `msg_${archivedRootThreadId.slice(-10)}`,
        rootStreamId: archivedChannelId,
        createdBy: ownerId,
      })

      await E2eStreamsRepository.markStreamE2e(client, {
        streamId: e2eChannelId,
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
      await BotChannelAccessRepository.grantAccess(client, {
        id: botChannelAccessId(),
        workspaceId: testWorkspaceId,
        botId: readerBotId,
        streamId: grantedChannelId,
        grantedBy: ownerId,
      })
    })
    await pool.query(`UPDATE streams SET archived_at = NOW() WHERE id = $1`, [archivedChannelId])
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should fail a readable-but-not-added write with a 403 STREAM_READ_ONLY / not_a_member", async () => {
    const error = (await writeAs(readerBotId, privateChannelId).catch((err: unknown) => err)) as HttpError
    expect(error).toBeInstanceOf(HttpError)
    expect({ status: error.status, code: error.code, details: error.details }).toEqual({
      status: 403,
      code: "STREAM_READ_ONLY",
      details: { reason: "not_a_member" },
    })
  })

  test("should keep the existence-hiding 404 for a flag-off personal bot and a shared bot", async () => {
    for (const otherBotId of [plainBotId, sharedBotId]) {
      await expectHidden404(writeAs(otherBotId, privateChannelId))
    }
  })

  test("should keep the 404 on an E2E-rooted stream the owner can read", async () => {
    await expectHidden404(writeAs(readerBotId, e2eChannelId))
  })

  test("should keep the 404 on an archived stream the owner can read", async () => {
    await expectHidden404(writeAs(readerBotId, archivedChannelId))
  })

  test("should keep the 404 on a live thread whose root is archived", async () => {
    // Only the root's archived_at flips on archive; the thread row stays live.
    await expectHidden404(writeAs(readerBotId, archivedRootThreadId))
  })

  test("should let a granted bot write", async () => {
    const authority = await writeAs(readerBotId, grantedChannelId)
    expect(authority.state).toEqual({ readOnly: false, readOnlyReason: null })
  })
})
