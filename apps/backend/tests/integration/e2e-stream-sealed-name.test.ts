/**
 * E2E sealed-stream-name integration tests.
 *
 * Exercises the runtime path that unit tests can't: the additive migration
 * columns on `e2e_streams`, `updateSealedName`'s BYTEA + JSONB binding, the
 * `streams ⋈ e2e_streams` read projection, and `mapRowToStream`'s base64
 * surfacing — end-to-end against a real Postgres.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes } from "@threa/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { ConversationRepository } from "../../src/features/conversations"
import { userId, workspaceId, streamId, conversationId } from "../../src/lib/id"

const MIGRATION_PATH = new URL("../../src/db/migrations/20260806220444_dynamic_naming_provenance.sql", import.meta.url)

const ENVELOPE = { v: 2, keyGeneration: 0, iv: "aXYxMjM0NTY3OA==", aad: "c3RyZWFtfG5hbWV8MA==" }

describe("E2E sealed stream name", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  /** Insert a workspace + member + scratchpad, optionally marking it E2E. */
  async function seedStream(e2e: boolean): Promise<{ wsId: string; sId: string; ownerId: string }> {
    const wsId = workspaceId()
    let ownerId = userId()
    const sId = streamId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Sealed Name WS",
        slug: `sealed-name-${wsId}`,
        createdBy: ownerId,
      })
      ownerId = (await addTestMember(client, wsId, ownerId)).id
      await StreamRepository.insert(client, {
        id: sId,
        workspaceId: wsId,
        type: StreamTypes.SCRATCHPAD,
        createdBy: ownerId,
      })
      if (e2e) {
        await E2eStreamsRepository.markStreamE2e(client, {
          streamId: sId,
          workspaceId: wsId,
          ownerUserId: ownerId,
          ownerUserKeyId: "e2ek_owner",
        })
      }
    })
    return { wsId, sId, ownerId }
  }

  test("blocking title lock waits for a contending stream transaction", async () => {
    const { sId } = await seedStream(true)
    const holder = await pool.connect()
    const waiter = await pool.connect()
    try {
      await holder.query("BEGIN")
      await StreamRepository.findByIdForUpdateBlocking(holder, sId)
      let acquired = false
      const waiting = StreamRepository.findByIdForUpdateBlocking(waiter, sId).then((stream) => {
        acquired = true
        return stream
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(acquired).toBe(false)
      await holder.query("COMMIT")
      expect((await waiting)?.id).toBe(sId)
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined)
      holder.release()
      waiter.release()
    }
  })

  test("migration backfills plaintext, sealed, and conversation titles while leaving unnamed rows source-null", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const wsId = workspaceId()
      let ownerId = userId()
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Migration backfill WS",
        slug: `migration-backfill-${wsId}`,
        createdBy: ownerId,
      })
      ownerId = (await addTestMember(client, wsId, ownerId)).id
      const plaintextId = streamId()
      const sealedId = streamId()
      const unnamedId = streamId()
      for (const [id, displayName] of [
        [plaintextId, "Existing title"],
        [sealedId, undefined],
        [unnamedId, undefined],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: wsId,
          type: StreamTypes.SCRATCHPAD,
          createdBy: ownerId,
          displayName,
          displayNameSource: displayName === undefined ? undefined : "explicit",
        })
      }
      await E2eStreamsRepository.markStreamE2e(client, {
        streamId: sealedId,
        workspaceId: wsId,
        ownerUserId: ownerId,
        ownerUserKeyId: "e2ek_owner",
      })
      await E2eStreamsRepository.updateSealedName(client, wsId, sealedId, {
        ciphertext: Buffer.from("existing-sealed-title").toString("base64"),
        envelope: ENVELOPE,
      })
      const titledConversationId = conversationId()
      const unnamedConversationId = conversationId()
      await ConversationRepository.insert(client, {
        id: titledConversationId,
        streamId: plaintextId,
        workspaceId: wsId,
        topicSummary: "Existing topic",
        topicSummarySource: "explicit",
      })
      await ConversationRepository.insert(client, {
        id: unnamedConversationId,
        streamId: unnamedId,
        workspaceId: wsId,
      })
      await client.query("UPDATE streams SET display_name = 'Leaky plaintext copy' WHERE id = $1", [sealedId])

      await client.query("DROP TRIGGER IF EXISTS preserve_legacy_stream_title_intent_trigger ON streams")
      await client.query("DROP FUNCTION IF EXISTS preserve_legacy_stream_title_intent()")
      await client.query("DROP TRIGGER IF EXISTS preserve_legacy_conversation_title_intent_trigger ON conversations")
      await client.query("DROP FUNCTION IF EXISTS preserve_legacy_conversation_title_intent()")
      await client.query("DROP TRIGGER IF EXISTS preserve_legacy_e2e_title_intent_trigger ON e2e_streams")
      await client.query("DROP FUNCTION IF EXISTS preserve_legacy_e2e_title_intent()")
      await client.query(
        "ALTER TABLE streams DROP COLUMN display_name_source, DROP COLUMN display_name_revision, DROP COLUMN display_name_updated_by_user_id"
      )
      await client.query(
        "ALTER TABLE conversations DROP COLUMN topic_summary_source, DROP COLUMN topic_summary_revision, DROP COLUMN topic_summary_updated_by_user_id"
      )
      await client.query(await Bun.file(MIGRATION_PATH).text())

      const streamRows = await client.query<{
        id: string
        display_name: string | null
        display_name_source: string | null
      }>("SELECT id, display_name, display_name_source FROM streams WHERE id = ANY($1)", [
        [plaintextId, sealedId, unnamedId],
      ])
      const streamSources = Object.fromEntries(streamRows.rows.map((row) => [row.id, row.display_name_source]))
      const conversationRows = await client.query<{ id: string; topic_summary_source: string | null }>(
        "SELECT id, topic_summary_source FROM conversations WHERE id = ANY($1)",
        [[titledConversationId, unnamedConversationId]]
      )
      const conversationSources = Object.fromEntries(
        conversationRows.rows.map((row) => [row.id, row.topic_summary_source])
      )
      expect(streamSources).toEqual({ [plaintextId]: "legacy", [sealedId]: "legacy", [unnamedId]: null })
      expect(streamRows.rows.find((row) => row.id === sealedId)?.display_name).toBeNull()
      expect(conversationSources).toEqual({ [titledConversationId]: "legacy", [unnamedConversationId]: null })

      // A pre-migration replica updates only the old title column. The rollout
      // trigger must preserve that human intent over a generated title.
      await client.query(
        "UPDATE streams SET display_name = 'Generated', display_name_source = 'generated', display_name_revision = 1 WHERE id = $1",
        [plaintextId]
      )
      await client.query("UPDATE streams SET display_name = 'Human old-replica edit' WHERE id = $1", [plaintextId])
      await client.query(
        "UPDATE conversations SET topic_summary = 'Generated', topic_summary_source = 'generated', topic_summary_revision = 1 WHERE id = $1",
        [titledConversationId]
      )
      await client.query("UPDATE conversations SET topic_summary = 'Human old-replica topic' WHERE id = $1", [
        titledConversationId,
      ])
      expect(
        (
          await client.query("SELECT display_name_source, display_name_revision FROM streams WHERE id = $1", [
            plaintextId,
          ])
        ).rows[0]
      ).toEqual({ display_name_source: "explicit", display_name_revision: 2 })
      expect(
        (
          await client.query("SELECT topic_summary_source, topic_summary_revision FROM conversations WHERE id = $1", [
            titledConversationId,
          ])
        ).rows[0]
      ).toEqual({ topic_summary_source: "explicit", topic_summary_revision: 2 })

      await client.query(
        "UPDATE streams SET display_name_source = 'generated', display_name_revision = 1 WHERE id = $1",
        [sealedId]
      )
      await client.query("SELECT set_config('threa.coordinated_title_write', '', true)")
      await client.query("UPDATE e2e_streams SET name_ciphertext = $1 WHERE workspace_id = $2 AND stream_id = $3", [
        Buffer.from("old-replica-manual-title"),
        wsId,
        sealedId,
      ])
      expect(
        (await client.query("SELECT display_name_source, display_name_revision FROM streams WHERE id = $1", [sealedId]))
          .rows[0]
      ).toEqual({ display_name_source: "explicit", display_name_revision: 2 })

      await client.query(
        "UPDATE streams SET display_name_source = 'generated', display_name_revision = 3 WHERE id = $1",
        [sealedId]
      )
      await E2eStreamsRepository.updateSealedName(client, wsId, sealedId, {
        ciphertext: Buffer.from("coordinated-new-replica-title").toString("base64"),
        envelope: ENVELOPE,
      })
      expect(
        (await client.query("SELECT display_name_source, display_name_revision FROM streams WHERE id = $1", [sealedId]))
          .rows[0]
      ).toEqual({ display_name_source: "generated", display_name_revision: 3 })
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
  })

  test("stores the sealed name and surfaces it (base64 + envelope) on the joined stream", async () => {
    const { wsId, sId } = await seedStream(true)
    const ciphertext = Buffer.from("sealed-display-name-ciphertext").toString("base64")

    const updated = await E2eStreamsRepository.updateSealedName(pool, wsId, sId, { ciphertext, envelope: ENVELOPE })
    expect(updated).toBe(true)
    expect(await E2eStreamsRepository.getSealedName(pool, wsId, sId)).toEqual({ ciphertext, envelope: ENVELOPE })

    const stream = await StreamRepository.findById(pool, sId)
    expect(stream?.e2eEnabled).toBe(true)
    expect(stream?.sealedNameCiphertext).toBe(ciphertext)
    expect(stream?.sealedNameEnvelope).toEqual(ENVELOPE)
  })

  test("a freshly-marked E2E stream has a null sealed name until first rename", async () => {
    const { sId } = await seedStream(true)
    const stream = await StreamRepository.findById(pool, sId)
    expect(stream?.e2eEnabled).toBe(true)
    expect(stream?.sealedNameCiphertext).toBeNull()
    expect(stream?.sealedNameEnvelope).toBeNull()
  })

  test("updateSealedName is fenced by the observed key generation", async () => {
    const { wsId, sId } = await seedStream(true)
    expect(
      await E2eStreamsRepository.updateSealedName(
        pool,
        wsId,
        sId,
        { ciphertext: Buffer.from("stale").toString("base64"), envelope: ENVELOPE },
        1
      )
    ).toBe(false)
    expect(await E2eStreamsRepository.getSealedName(pool, wsId, sId)).toBeNull()
  })

  test("updateSealedName no-ops for a plaintext (non-E2E) stream", async () => {
    const { wsId, sId } = await seedStream(false)

    const updated = await E2eStreamsRepository.updateSealedName(pool, wsId, sId, {
      ciphertext: Buffer.from("x").toString("base64"),
      envelope: ENVELOPE,
    })
    expect(updated).toBe(false)

    const stream = await StreamRepository.findById(pool, sId)
    // Plaintext streams omit the E2E join fields entirely.
    expect(stream?.e2eEnabled).toBeUndefined()
    expect(stream?.sealedNameCiphertext).toBeUndefined()
  })

  test("null clears a previously-stored sealed name (rename without a fresh seal)", async () => {
    const { wsId, sId } = await seedStream(true)
    const ciphertext = Buffer.from("sealed-name").toString("base64")
    await E2eStreamsRepository.updateSealedName(pool, wsId, sId, { ciphertext, envelope: ENVELOPE })
    expect((await StreamRepository.findById(pool, sId))?.sealedNameCiphertext).toBe(ciphertext)

    const cleared = await E2eStreamsRepository.updateSealedName(pool, wsId, sId, null)
    expect(cleared).toBe(true)
    const stream = await StreamRepository.findById(pool, sId)
    expect(stream?.sealedNameCiphertext).toBeNull()
    expect(stream?.sealedNameEnvelope).toBeNull()
  })

  test("first auto-title writes ciphertext and generated revision atomically, then explicit provenance blocks it", async () => {
    const { wsId, sId, ownerId } = await seedStream(true)
    const ciphertext = Buffer.from("auto-title").toString("base64")

    await withTransaction(pool, async (client) => {
      const locked = await StreamRepository.findByIdForUpdate(client, sId)
      expect(locked?.displayNameSource).toBeNull()
      expect(
        await E2eStreamsRepository.setSealedNameIfAbsent(client, wsId, sId, { ciphertext, envelope: ENVELOPE })
      ).toBe(true)
      expect(
        await StreamRepository.updateDisplayName(client, {
          workspaceId: wsId,
          streamId: sId,
          displayName: null,
          source: "generated",
          expectedRevision: locked!.displayNameRevision,
          expectedSource: null,
        })
      ).not.toBeNull()
    })

    let stream = await StreamRepository.findById(pool, sId)
    expect({
      ciphertext: stream?.sealedNameCiphertext,
      source: stream?.displayNameSource,
      revision: stream?.displayNameRevision,
      actor: stream?.displayNameUpdatedByUserId,
    }).toEqual({ ciphertext, source: "generated", revision: 1, actor: null })

    await StreamRepository.updateDisplayName(pool, {
      workspaceId: wsId,
      streamId: sId,
      displayName: null,
      source: "explicit",
      updatedByUserId: ownerId,
    })
    expect(
      await E2eStreamsRepository.setSealedNameIfAbsent(pool, wsId, sId, {
        ciphertext: Buffer.from("late-auto").toString("base64"),
        envelope: ENVELOPE,
      })
    ).toBe(false)
    stream = await StreamRepository.findById(pool, sId)
    expect({
      source: stream?.displayNameSource,
      revision: stream?.displayNameRevision,
      actor: stream?.displayNameUpdatedByUserId,
    }).toEqual({
      source: "explicit",
      revision: 2,
      actor: ownerId,
    })
  })

  test("source-null sealed rows map conservatively to legacy", async () => {
    const { wsId, sId } = await seedStream(true)
    await E2eStreamsRepository.updateSealedName(pool, wsId, sId, {
      ciphertext: Buffer.from("old-replica-title").toString("base64"),
      envelope: ENVELOPE,
    })
    expect((await StreamRepository.findByIdForWorkspace(pool, sId, wsId))?.displayNameSource).toBe("legacy")
    expect((await StreamRepository.findByIdForUpdate(pool, sId))?.displayNameSource).toBe("legacy")
    expect((await StreamRepository.findByIdForUpdateBlocking(pool, sId))?.displayNameSource).toBe("legacy")
    const updated = await StreamRepository.updateDisplayName(pool, {
      workspaceId: wsId,
      streamId: sId,
      displayName: null,
      source: "generated",
      expectedRevision: 0,
      expectedSource: "legacy",
    })
    expect(updated).toMatchObject({ displayNameSource: "generated", displayNameRevision: 1 })
  })

  test("rejects non-canonical base64 instead of storing a corrupt blob", async () => {
    const { wsId, sId } = await seedStream(true)
    await expect(
      E2eStreamsRepository.updateSealedName(pool, wsId, sId, { ciphertext: "!!!!", envelope: ENVELOPE })
    ).rejects.toThrow(/base64/)
  })
})
