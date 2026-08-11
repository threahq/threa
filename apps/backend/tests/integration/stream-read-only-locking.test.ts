import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { EventService } from "../../src/features/messaging/event-service"
import { MessageRepository } from "../../src/features/messaging/repository"
import { BotRepository } from "../../src/features/public-api/bot-repository"
import {
  StreamMemberRepository,
  StreamRepository,
  StreamService,
  assertStreamWritable,
  type StreamWritePrincipal,
} from "../../src/features/streams"
import { setupTestDatabase } from "./setup"

describe("stream write lock statements", () => {
  let pool: Pool
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10)
  const workspaceId = `ws_lock_${suffix}`
  const userId = `usr_lock_${suffix}`
  const botId = `bot_lock_${suffix}`
  const rootId = `stream_root_${suffix}`
  const threadId = `stream_thread_${suffix}`

  beforeAll(async () => {
    pool = await setupTestDatabase()
    await pool.query("INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Locks', $2, $3)", [
      workspaceId,
      `locks-${suffix}`,
      userId,
    ])
    await pool.query(
      "INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name) VALUES ($1,$2,$3,$4,'member',$5,'Locker')",
      [userId, workspaceId, `wos_${suffix}`, `lock-${suffix}@test.local`, `locker-${suffix}`]
    )
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1,$2,'channel','private',$3)",
      [rootId, workspaceId, userId]
    )
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, parent_stream_id, root_stream_id, created_by) VALUES ($1,$2,'thread','private',$3,$3,$4)",
      [threadId, workspaceId, rootId, userId]
    )
    await pool.query("INSERT INTO stream_members (stream_id, member_id) VALUES ($1,$2)", [rootId, userId])
    await pool.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1,$2,$3,'Locker bot')", [
      botId,
      workspaceId,
      `key_${suffix}`,
    ])
    await BotChannelAccessRepository.grantAccess(pool, {
      id: `bca_${suffix}`,
      workspaceId,
      botId,
      streamId: rootId,
      grantedBy: userId,
    })
  })

  afterAll(async () => {
    await pool.query("DELETE FROM bot_channel_access WHERE workspace_id=$1", [workspaceId])
    await pool.query("DELETE FROM stream_members WHERE stream_id = ANY($1)", [[rootId, threadId]])
    await pool.query("DELETE FROM bots WHERE id=$1", [botId])
    await pool.query("DELETE FROM streams WHERE workspace_id=$1", [workspaceId])
    await pool.query("DELETE FROM users WHERE workspace_id=$1", [workspaceId])
    await pool.query("DELETE FROM workspaces WHERE id=$1", [workspaceId])
    await pool.end()
  })

  test("executes stable stream, membership, and grant FOR UPDATE statements against schema", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      expect(
        (await StreamRepository.findByIdsForUpdateBlocking(client, workspaceId, [threadId, rootId])).map((s) => s.id)
      ).toEqual([rootId, threadId].sort())
      expect(await StreamMemberRepository.lockMemberships(client, [rootId], userId)).toEqual(new Set([rootId]))
      expect(await StreamMemberRepository.lockMemberPairs(client, [{ streamId: rootId, memberId: userId }])).toEqual(
        new Set([`${rootId}:${userId}`])
      )
      expect(await BotChannelAccessRepository.lockGrants(client, workspaceId, botId, [rootId])).toEqual(
        new Set([rootId])
      )
      await client.query("ROLLBACK")
    } finally {
      client.release()
    }
  })

  test("locks a bot row with production SQL", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      expect((await BotRepository.findByIdForUpdate(client, workspaceId, botId))?.id).toBe(botId)
      await client.query("ROLLBACK")
    } finally {
      client.release()
    }
  })

  test("grant and bot archive serialize; archive winner prevents a grant transition", async () => {
    const service = new StreamService(pool)
    await pool.query("DELETE FROM bot_channel_access WHERE workspace_id=$1 AND bot_id=$2", [workspaceId, botId])
    const grant = await pool.connect()
    const archive = await pool.connect()
    try {
      await grant.query("BEGIN")
      await service.addBotToStreamOn(grant, threadId, botId, workspaceId, userId)
      const archivePromise = BotRepository.archive(archive, botId, workspaceId)
      expect(await Promise.race([archivePromise.then(() => "finished"), Bun.sleep(40).then(() => "blocked")])).toBe(
        "blocked"
      )
      await grant.query("COMMIT")
      expect((await archivePromise)?.archivedAt).not.toBeNull()
      expect(
        (await pool.query("SELECT 1 FROM bot_channel_access WHERE workspace_id=$1 AND bot_id=$2", [workspaceId, botId]))
          .rowCount
      ).toBe(1)
      await pool.query("DELETE FROM bot_channel_access WHERE workspace_id=$1 AND bot_id=$2", [workspaceId, botId])
      await expect(service.addBotToStream(threadId, botId, workspaceId, userId)).rejects.toMatchObject({ status: 404 })
      expect(
        (await pool.query("SELECT 1 FROM bot_channel_access WHERE workspace_id=$1 AND bot_id=$2", [workspaceId, botId]))
          .rowCount
      ).toBe(0)
      await BotRepository.restore(pool, botId, workspaceId)
      await BotChannelAccessRepository.grantAccess(pool, {
        id: `bca_race_restore_${suffix}`,
        workspaceId,
        botId,
        streamId: rootId,
        grantedBy: userId,
      })
    } finally {
      await grant.query("ROLLBACK").catch(() => {})
      grant.release()
      archive.release()
    }
  })

  test("refuses a bot grant on an archived stream", async () => {
    const archivedId = `stream_archived_grant_${suffix}`
    await pool.query(
      "INSERT INTO streams (id,workspace_id,type,visibility,created_by,archived_at) VALUES ($1,$2,'channel','private',$3,NOW())",
      [archivedId, workspaceId, userId]
    )
    await expect(new StreamService(pool).addBotToStream(archivedId, botId, workspaceId, userId)).rejects.toMatchObject({
      status: 404,
      code: "STREAM_NOT_FOUND",
    })
    expect(
      (
        await pool.query("SELECT 1 FROM bot_channel_access WHERE workspace_id=$1 AND bot_id=$2 AND stream_id=$3", [
          workspaceId,
          botId,
          archivedId,
        ])
      ).rowCount
    ).toBe(0)
  })

  test("retries edit, delete, and reactions when stale archived placement masks a move", async () => {
    const staleId = `stream_stale_${suffix}`
    const currentId = `stream_current_${suffix}`
    await pool.query(
      "INSERT INTO streams (id,workspace_id,type,visibility,created_by,archived_at) VALUES ($1,$2,'channel','private',$3,NOW()),($4,$2,'channel','private',$3,NULL)",
      [staleId, workspaceId, userId, currentId]
    )
    await pool.query("INSERT INTO stream_members (stream_id,member_id) VALUES ($1,$3),($2,$3)", [
      staleId,
      currentId,
      userId,
    ])
    const service = new EventService(pool)
    const principal = { kind: "user" as const, userId }
    const makeMessage = async () =>
      service.createMessage({
        workspaceId,
        streamId: currentId,
        authorId: userId,
        authorType: "user",
        contentJson,
        contentMarkdown: "locked",
      })
    const staleSnapshot = (message: Awaited<ReturnType<typeof makeMessage>>) => ({ ...message, streamId: staleId })

    const editedMessage = await makeMessage()
    spyOn(MessageRepository, "findById").mockResolvedValueOnce(staleSnapshot(editedMessage))
    expect(
      (
        await service.editMessageForPrincipal(principal, {
          workspaceId,
          messageId: editedMessage.id,
          streamId: staleId,
          actorId: userId,
          actorType: "user",
          contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "edited" }] }] },
          contentMarkdown: "edited",
        })
      )?.streamId
    ).toBe(currentId)

    const deletedMessage = await makeMessage()
    spyOn(MessageRepository, "findById").mockResolvedValueOnce(staleSnapshot(deletedMessage))
    expect(
      (
        await service.deleteMessageForPrincipal(principal, {
          workspaceId,
          messageId: deletedMessage.id,
          streamId: staleId,
          actorId: userId,
          actorType: "user",
        })
      )?.streamId
    ).toBe(currentId)

    const reactionMessage = await makeMessage()
    spyOn(MessageRepository, "findById").mockResolvedValueOnce(staleSnapshot(reactionMessage))
    expect(
      (
        await service.addReactionForPrincipal(principal, {
          workspaceId,
          messageId: reactionMessage.id,
          streamId: staleId,
          emoji: "👍",
          userId,
          actorType: "user",
        })
      )?.streamId
    ).toBe(currentId)
    spyOn(MessageRepository, "findById").mockResolvedValueOnce(staleSnapshot(reactionMessage))
    expect(
      (
        await service.removeReactionForPrincipal(principal, {
          workspaceId,
          messageId: reactionMessage.id,
          streamId: staleId,
          emoji: "👍",
          userId,
          actorType: "user",
        })
      )?.streamId
    ).toBe(currentId)

    const deniedMessages = await Promise.all([makeMessage(), makeMessage(), makeMessage(), makeMessage()])
    await pool.query("UPDATE streams SET type='system' WHERE id=$1", [currentId])
    const deniedOperations = [
      () =>
        service.editMessageForPrincipal(principal, {
          workspaceId,
          messageId: deniedMessages[0].id,
          streamId: staleId,
          actorId: userId,
          actorType: "user",
          contentJson,
          contentMarkdown: "denied",
        }),
      () =>
        service.deleteMessageForPrincipal(principal, {
          workspaceId,
          messageId: deniedMessages[1].id,
          streamId: staleId,
          actorId: userId,
          actorType: "user",
        }),
      () =>
        service.addReactionForPrincipal(principal, {
          workspaceId,
          messageId: deniedMessages[2].id,
          streamId: staleId,
          emoji: "👍",
          userId,
          actorType: "user",
        }),
      () =>
        service.removeReactionForPrincipal(principal, {
          workspaceId,
          messageId: deniedMessages[3].id,
          streamId: staleId,
          emoji: "👍",
          userId,
          actorType: "user",
        }),
    ]
    for (let index = 0; index < deniedOperations.length; index++) {
      spyOn(MessageRepository, "findById").mockResolvedValueOnce(staleSnapshot(deniedMessages[index]))
      await expect(deniedOperations[index]()).rejects.toMatchObject({
        code: "STREAM_READ_ONLY",
        details: { reason: "system_stream" },
      })
    }

    await pool.query("DELETE FROM stream_members WHERE stream_id=ANY($1)", [[staleId, currentId]])
    await pool.query("DELETE FROM streams WHERE id=ANY($1)", [[staleId, currentId]])
  })

  test("checks thread participation at the effective root for users and bots", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      expect(
        (await assertStreamWritable(client, { workspaceId, streamId: threadId, principal: { kind: "user", userId } }))
          .root.id
      ).toBe(rootId)
      await client.query("ROLLBACK")
      await client.query("BEGIN")
      expect(
        (await assertStreamWritable(client, { workspaceId, streamId: threadId, principal: { kind: "bot", botId } }))
          .root.id
      ).toBe(rootId)
      await client.query("ROLLBACK")
    } finally {
      client.release()
    }
  })

  const contentJson = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "locked" }] }] }

  async function guardedSend(client: import("pg").PoolClient, principal: StreamWritePrincipal, streamId: string) {
    const service = new EventService(pool)
    await assertStreamWritable(client, { workspaceId, streamId, principal })
    return service.createMessageInTransaction(client, {
      workspaceId,
      streamId,
      authorId: principal.kind === "user" ? principal.userId : principal.botId,
      authorType: principal.kind,
      contentJson,
      contentMarkdown: "locked",
      clientMessageId: `cmid_${crypto.randomUUID()}`,
    })
  }

  const cases = [
    {
      name: "direct archive",
      streamId: rootId,
      principal: { kind: "user", userId } as const,
      transition: `UPDATE streams SET archived_at=NOW() WHERE id=$1`,
      reset: `UPDATE streams SET archived_at=NULL WHERE id=$1`,
    },
    {
      name: "root archive",
      streamId: threadId,
      principal: { kind: "user", userId } as const,
      transition: `UPDATE streams SET archived_at=NOW() WHERE id=$1`,
      reset: `UPDATE streams SET archived_at=NULL WHERE id=$1`,
      transitionId: rootId,
    },
    {
      name: "human removal",
      streamId: rootId,
      principal: { kind: "user", userId } as const,
      transition: `DELETE FROM stream_members WHERE stream_id=$1 AND member_id='${userId}'`,
      reset: `INSERT INTO stream_members (stream_id,member_id) VALUES ($1,'${userId}') ON CONFLICT DO NOTHING`,
    },
    {
      name: "bot revoke",
      streamId: rootId,
      principal: { kind: "bot", botId } as const,
      transition: `DELETE FROM bot_channel_access WHERE stream_id=$1 AND bot_id='${botId}'`,
      reset: `INSERT INTO bot_channel_access (id,workspace_id,bot_id,stream_id,granted_by) VALUES ('bca_reset_${suffix}','${workspaceId}','${botId}',$1,'${userId}') ON CONFLICT (workspace_id,bot_id,stream_id) DO NOTHING`,
    },
  ]

  async function resetAuthorityFacts() {
    await pool.query("UPDATE streams SET archived_at=NULL WHERE id=$1", [rootId])
    await pool.query("INSERT INTO stream_members (stream_id,member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [
      rootId,
      userId,
    ])
    await pool.query(
      "INSERT INTO bot_channel_access (id,workspace_id,bot_id,stream_id,granted_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id,bot_id,stream_id) DO NOTHING",
      [`bca_reset_${suffix}`, workspaceId, botId, rootId, userId]
    )
  }

  for (const scenario of cases) {
    test(`${scenario.name}: send lock winner commits before transition`, async () => {
      await resetAuthorityFacts()
      await pool.query(scenario.reset, [scenario.transitionId ?? rootId])
      const writer = await pool.connect()
      const transition = await pool.connect()
      try {
        await writer.query("BEGIN")
        const sent = await guardedSend(writer, scenario.principal, scenario.streamId)
        const transitionPromise = transition.query(scenario.transition, [scenario.transitionId ?? rootId])
        expect(
          await Promise.race([transitionPromise.then(() => "finished"), Bun.sleep(40).then(() => "blocked")])
        ).toBe("blocked")
        await writer.query("COMMIT")
        await transitionPromise
        expect((await pool.query("SELECT 1 FROM messages WHERE id=$1", [sent.message.id])).rowCount).toBe(1)
      } finally {
        await writer.query("ROLLBACK").catch(() => {})
        writer.release()
        transition.release()
      }
    })

    test(`${scenario.name}: completed transition denies queued send`, async () => {
      await resetAuthorityFacts()
      await pool.query(scenario.reset, [scenario.transitionId ?? rootId])
      const transition = await pool.connect()
      const writer = await pool.connect()
      try {
        const beforeCount = Number(
          (await pool.query("SELECT COUNT(*)::int AS count FROM messages WHERE stream_id=$1", [scenario.streamId]))
            .rows[0].count
        )
        await transition.query("BEGIN")
        await transition.query(scenario.transition, [scenario.transitionId ?? rootId])
        await writer.query("BEGIN")
        const sendPromise = guardedSend(writer, scenario.principal, scenario.streamId)
        expect(
          await Promise.race([
            sendPromise.then(
              () => "finished",
              () => "rejected"
            ),
            Bun.sleep(40).then(() => "blocked"),
          ])
        ).toBe("blocked")
        await transition.query("COMMIT")
        await expect(sendPromise).rejects.toMatchObject({ status: expect.any(Number) })
        await writer.query("ROLLBACK")
        const afterCount = Number(
          (await pool.query("SELECT COUNT(*)::int AS count FROM messages WHERE stream_id=$1", [scenario.streamId]))
            .rows[0].count
        )
        expect(afterCount).toBe(beforeCount)
      } finally {
        await transition.query("ROLLBACK").catch(() => {})
        await writer.query("ROLLBACK").catch(() => {})
        transition.release()
        writer.release()
      }
    })
  }
})
