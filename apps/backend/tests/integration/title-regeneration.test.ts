import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { StreamTypes } from "@threa/types"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamMemberRepository, StreamRepository, StreamService } from "../../src/features/streams"
import { ConversationRepository, ConversationService } from "../../src/features/conversations"
import { DynamicNamingStateRepository } from "../../src/features/dynamic-naming"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { conversationId, streamId, userId, workspaceId } from "../../src/lib/id"

const nameEnvelope = (streamId: string) => ({
  v: 2,
  keyGeneration: 0,
  iv: "aXY=",
  aad: Buffer.from(`${streamId}|name|0`).toString("base64"),
})

describe("title regeneration", () => {
  let pool: Pool
  beforeAll(async () => void (pool = await setupTestDatabase()))
  afterAll(async () => void (await pool.end()))

  async function fixture() {
    const wsId = workspaceId()
    let ownerId = userId()
    const sId = streamId()
    await withTransaction(pool, async (tx) => {
      await WorkspaceRepository.insert(tx, {
        id: wsId,
        name: "Regeneration WS",
        slug: `regeneration-${wsId}`,
        createdBy: ownerId,
      })
      ownerId = (await addTestMember(tx, wsId, ownerId)).id
      await StreamRepository.insert(tx, {
        id: sId,
        workspaceId: wsId,
        type: StreamTypes.SCRATCHPAD,
        displayName: "Incident notes",
        displayNameSource: "explicit",
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(tx, sId, ownerId)
    })
    return { wsId, ownerId, sId }
  }

  test("preserves a plaintext stream title while resetting lifecycle and writing the request atomically", async () => {
    const { wsId, ownerId, sId } = await fixture()
    const state = await DynamicNamingStateRepository.ensure(pool, {
      workspaceId: wsId,
      targetKind: "stream",
      targetId: sId,
    })
    await pool.query("UPDATE dynamic_naming_state SET consecutive_keeps = 2, completed_at = NOW() WHERE id = $1", [
      state.id,
    ])

    const result = await new StreamService(pool).regenerateDisplayName(wsId, sId, {
      kind: "user",
      userId: ownerId,
    })

    expect(result).toMatchObject({
      deferred: false,
      stream: { displayName: "Incident notes", displayNameSource: "generated", displayNameRevision: 2 },
    })
    expect(await DynamicNamingStateRepository.find(pool, wsId, "stream", sId)).toMatchObject({
      consecutiveKeeps: 0,
      completedAt: null,
      regenerationPending: true,
      structureVersion: 1,
    })
    const outbox = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM outbox WHERE payload->>'targetId' = $1 OR payload->>'streamId' = $1",
      [sId]
    )
    expect(outbox.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining(["stream:updated", "dynamic_naming:requested"])
    )
  })

  test("preserves a conversation topic and makes it generated", async () => {
    const { wsId, ownerId, sId } = await fixture()
    const channelId = streamId()
    const cId = conversationId()
    await withTransaction(pool, async (tx) => {
      await StreamRepository.insert(tx, {
        id: channelId,
        workspaceId: wsId,
        type: StreamTypes.CHANNEL,
        slug: `regen-${channelId}`,
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(tx, channelId, ownerId)
      await ConversationRepository.insert(tx, {
        id: cId,
        workspaceId: wsId,
        streamId: channelId,
        topicSummary: "Migration rollback",
        topicSummarySource: "explicit",
      })
    })

    const result = await new ConversationService(pool).regenerateTitle({
      workspaceId: wsId,
      conversationId: cId,
      actorUserId: ownerId,
    })

    expect(result.conversation).toMatchObject({
      topicSummary: "Migration rollback",
      topicSummarySource: "generated",
      topicSummaryRevision: 2,
    })
    expect(await DynamicNamingStateRepository.find(pool, wsId, "conversation", cId)).toMatchObject({
      regenerationPending: true,
      structureVersion: 1,
    })
    expect(sId).not.toBe(channelId)
  })

  test("E2E regeneration replaces only sealed bytes and defers evaluation to the next turn", async () => {
    const { wsId, ownerId, sId } = await fixture()
    await withTransaction(pool, async (tx) => {
      await E2eStreamsRepository.markStreamE2e(tx, {
        streamId: sId,
        workspaceId: wsId,
        ownerUserId: ownerId,
        ownerUserKeyId: "e2ek_owner",
      })
      await StreamRepository.updateDisplayName(tx, {
        workspaceId: wsId,
        streamId: sId,
        displayName: null,
        source: "explicit",
      })
    })
    const ciphertext = Buffer.from("freshly-resealed-current-title").toString("base64")
    const envelope = nameEnvelope(sId)

    const result = await new StreamService(pool).regenerateDisplayName(
      wsId,
      sId,
      { kind: "user", userId: ownerId },
      { ciphertext, envelope }
    )

    expect(result).toMatchObject({ deferred: true, stream: { displayName: null, displayNameSource: "generated" } })
    expect(await E2eStreamsRepository.getSealedName(pool, wsId, sId)).toEqual({ ciphertext, envelope })
  })
})
