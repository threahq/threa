import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { ActivityTypes, AuthorTypes, ContextIntents, ContextRefKinds, StreamTypes, Visibilities } from "@threahq/types"
import { setupTestDatabase, testMessageContent, withClient } from "./setup"
import { ActivityRepository } from "../../src/features/activity"
import {
  ContextBagRepository,
  ConversationSummaryRepository,
  StreamPersonaParticipantRepository,
} from "../../src/features/agents"
import { AttachmentReferenceRepository, VideoTranscodeJobRepository } from "../../src/features/attachments"
import { BoardExclusionRepository, MessageConversationStateRepository } from "../../src/features/conversations"
import { MessageComposeTraceRepository, MessageRepository } from "../../src/features/messaging"
import {
  ReadStateRepository,
  SparseReadRepository,
  StreamBriefRepository,
  StreamEventRepository,
  StreamMemberRepository,
  StreamPoliciesRepository,
  StreamRepository,
} from "../../src/features/streams"
import { UserPreferencesRepository } from "../../src/features/user-preferences"
import {
  agentConversationSummaryId,
  attachmentId,
  attachmentReferenceId,
  conversationId,
  eventId,
  messageId,
  personaId,
  streamBriefId,
  streamId,
  userId,
  videoTranscodeJobId,
  workspaceId,
} from "../../src/lib/id"

/**
 * Each statement below names a workspace-leading twin key in its ON CONFLICT
 * target. Postgres infers the arbiter at plan time, so a statement that runs
 * proves the target matches a real index; running it twice takes the conflict
 * path.
 */
describe("workspace-leading ON CONFLICT arbiters", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should return the existing thread when a thread is created twice for one anchor", async () => {
    const ws = workspaceId()
    const root = streamId()
    const creator = userId()
    const anchor = messageId()
    const params = (id: string) => ({
      id,
      workspaceId: ws,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PRIVATE,
      parentStreamId: root,
      parentAnchorId: anchor,
      rootStreamId: root,
      createdBy: creator,
    })
    const firstId = streamId()

    const first = await StreamRepository.insertThreadOrFind(pool, params(firstId))
    const second = await StreamRepository.insertThreadOrFind(pool, params(streamId()))

    expect([
      { created: first.created, id: first.stream.id },
      { created: second.created, id: second.stream.id },
    ]).toEqual([
      { created: true, id: firstId },
      { created: false, id: firstId },
    ])
  })

  test("should keep one member row when the same member is inserted twice", async () => {
    const ws = workspaceId()
    const stream = streamId()
    const member = userId()
    const other = userId()

    await StreamMemberRepository.insert(pool, ws, stream, member)
    await StreamMemberRepository.insert(pool, ws, stream, member)
    await StreamMemberRepository.insertMany(pool, ws, stream, [member, other])

    const rows = await pool.query<{ member_id: string }>(
      "SELECT member_id FROM stream_members WHERE workspace_id = $1 AND stream_id = $2 ORDER BY member_id",
      [ws, stream]
    )
    expect(rows.rows.map((row) => row.member_id)).toEqual([member, other].sort())
  })

  test("should hand out consecutive sequence ranges when a stream allocates twice", async () => {
    const ws = workspaceId()
    const stream = streamId()

    const first = await StreamEventRepository.allocateSequences(pool, ws, stream, { total: 2, broadcast: 1 })
    const second = await StreamEventRepository.allocateSequences(pool, ws, stream, { total: 3, broadcast: 2 })

    const rows = await pool.query<{ next_sequence: string; next_broadcast_sequence: string }>(
      "SELECT next_sequence, next_broadcast_sequence FROM stream_sequences WHERE workspace_id = $1 AND stream_id = $2",
      [ws, stream]
    )
    expect({ first, second, rows: rows.rows }).toEqual({
      first: { firstSequence: 1n, firstBroadcastSequence: 1n },
      second: { firstSequence: 3n, firstBroadcastSequence: 2n },
      rows: [{ next_sequence: "6", next_broadcast_sequence: "4" }],
    })
  })

  test("should replace the stored policy when a stream's tool policy is set twice", async () => {
    const ws = workspaceId()
    const stream = streamId()

    await StreamPoliciesRepository.setToolPolicy(pool, ws, stream, ["web"])
    await StreamPoliciesRepository.setToolPolicy(pool, ws, stream, ["workspace"])

    expect(await StreamPoliciesRepository.getToolPolicy(pool, ws, stream)).toEqual(["workspace"])
  })

  test("should keep the first brief when a second create loses the race", async () => {
    const ws = workspaceId()
    const stream = streamId()
    const author = userId()
    const insert = (id: string, content: string) =>
      StreamBriefRepository.insertFirstVersion(pool, {
        id,
        workspaceId: ws,
        streamId: stream,
        content,
        updatedByKind: AuthorTypes.USER,
        updatedById: author,
      })
    const firstId = streamBriefId()

    const first = await insert(firstId, "Goal: ship v2")
    const second = await insert(streamBriefId(), "Goal: ship v3")
    const stored = await StreamBriefRepository.findByStreamId(pool, ws, stream)

    expect({ first: first?.id, second, stored: { id: stored?.id, content: stored?.content } }).toEqual({
      first: firstId,
      second: null,
      stored: { id: firstId, content: "Goal: ship v2" },
    })
  })

  test("should replace the refs on the original row when a context bag is saved twice for one intent", async () => {
    const ws = workspaceId()
    const stream = streamId()
    const creator = userId()
    const insert = (refStreamId: string) =>
      ContextBagRepository.insert(pool, {
        workspaceId: ws,
        streamId: stream,
        intent: ContextIntents.DISCUSS_THREAD,
        refs: [{ kind: ContextRefKinds.THREAD, streamId: refStreamId }],
        createdBy: creator,
      })
    const secondRefStream = streamId()

    const first = await insert(streamId())
    const second = await insert(secondRefStream)

    expect({ id: second.id, refs: second.refs }).toEqual({
      id: first.id,
      refs: [{ kind: ContextRefKinds.THREAD, streamId: secondRefStream }],
    })
  })

  test("should keep one summary row when a conversation summary is upserted twice", async () => {
    const ws = workspaceId()
    const stream = streamId()
    const persona = personaId()
    const firstId = agentConversationSummaryId()
    const upsert = (id: string, summary: string, lastSummarizedSequence: bigint) =>
      ConversationSummaryRepository.upsert(pool, {
        id,
        workspaceId: ws,
        streamId: stream,
        personaId: persona,
        summary,
        lastSummarizedSequence,
      })

    await upsert(firstId, "first", 1n)
    const second = await upsert(agentConversationSummaryId(), "second", 2n)

    expect({ id: second.id, summary: second.summary, lastSummarizedSequence: second.lastSummarizedSequence }).toEqual({
      id: firstId,
      summary: "second",
      lastSummarizedSequence: 2n,
    })
  })

  test("should record a persona once when it participates twice in a stream", async () => {
    const ws = workspaceId()
    const stream = streamId()
    const persona = personaId()

    await withClient(pool, async (client) => {
      await StreamPersonaParticipantRepository.recordParticipation(client, ws, stream, persona)
      await StreamPersonaParticipantRepository.recordParticipation(client, ws, stream, persona)
    })

    const rows = await pool.query<{ persona_id: string }>(
      "SELECT persona_id FROM stream_persona_participants WHERE workspace_id = $1 AND stream_id = $2",
      [ws, stream]
    )
    expect(rows.rows).toEqual([{ persona_id: persona }])
  })

  test("should keep one reference row when the same attachment is referenced twice by a message", async () => {
    const ws = workspaceId()
    const attachment = attachmentId()
    const message = messageId()
    const stream = streamId()
    const reference = () => ({
      id: attachmentReferenceId(),
      workspaceId: ws,
      attachmentId: attachment,
      messageId: message,
      streamId: stream,
    })

    const first = await AttachmentReferenceRepository.insertMany(pool, [reference()])
    const second = await AttachmentReferenceRepository.insertMany(pool, [reference()])

    expect({
      first,
      second,
      stored: (await AttachmentReferenceRepository.findByAttachmentId(pool, ws, attachment)).map(
        (row) => row.messageId
      ),
    }).toEqual({ first: 1, second: 0, stored: [message] })
  })

  test("should reset the existing job when a video job is upserted twice for one attachment", async () => {
    const ws = workspaceId()
    const attachment = attachmentId()
    const firstId = videoTranscodeJobId()
    const params = (id: string) => ({ id, workspaceId: ws, attachmentId: attachment })

    await VideoTranscodeJobRepository.upsert(pool, params(firstId))
    const submitted = await VideoTranscodeJobRepository.updateSubmitted(pool, ws, firstId, "mc_1")
    const second = await VideoTranscodeJobRepository.upsert(pool, params(videoTranscodeJobId()))

    expect({ submitted, id: second.id, status: second.status, mediaconvertJobId: second.mediaconvertJobId }).toEqual({
      submitted: true,
      id: firstId,
      status: "pending",
      mediaconvertJobId: null,
    })
  })

  test("should keep one hidden row stamped by the second hide when a conversation is hidden twice", async () => {
    const ws = workspaceId()
    const conversation = conversationId()
    const viewer = userId()
    const hide = () =>
      BoardExclusionRepository.hideConversation(pool, { workspaceId: ws, conversationId: conversation, userId: viewer })

    const backdated = new Date("2000-01-01T00:00:00Z")

    await hide()
    await pool.query(
      "UPDATE board_hidden_conversations SET hidden_at = $3 WHERE workspace_id = $1 AND conversation_id = $2",
      [ws, conversation, backdated]
    )
    const second = await hide()

    expect({
      rows: await BoardExclusionRepository.listHiddenConversations(pool, ws, viewer),
      restamped: second.hiddenAt > backdated,
    }).toEqual({ rows: [{ conversationId: conversation, hiddenAt: second.hiddenAt }], restamped: true })
  })

  test("should keep one muted row when a stream is muted twice", async () => {
    const ws = workspaceId()
    const stream = streamId()
    const viewer = userId()

    await BoardExclusionRepository.muteStream(pool, { workspaceId: ws, streamId: stream, userId: viewer })
    await BoardExclusionRepository.muteStream(pool, { workspaceId: ws, streamId: stream, userId: viewer })

    expect(await BoardExclusionRepository.listMutedStreamIds(pool, ws, viewer)).toEqual([stream])
  })

  interface SharedIds {
    root: string
    anchor: string
    stream: string
    member: string
    persona: string
    message: string
    attachment: string
    conversation: string
    refStreams: [string, string]
    events: [string, string]
  }

  const firstRow =
    (columns: string, table: string, by: "stream" | "message" | "attachment" | "conversation" = "stream") =>
    async (ws: string, ids: SharedIds) =>
      (await pool.query(`SELECT ${columns} FROM ${table} WHERE workspace_id = $1 AND ${by}_id = $2`, [ws, ids[by]]))
        .rows[0] ?? null

  // The old single-column streams key keeps one stream id out of two workspaces at once, so workspace B
  // takes the stream over from workspace A before its read-state write.
  const ownStream = async (ws: string, ids: SharedIds, writer: 0 | 1) => {
    if (writer === 0) {
      await StreamRepository.insert(pool, {
        id: ids.stream,
        workspaceId: ws,
        type: StreamTypes.CHANNEL,
        createdBy: ids.member,
      })
      return
    }
    await pool.query("UPDATE streams SET workspace_id = $1 WHERE id = $2", [ws, ids.stream])
  }

  // Writer 1 is self-authored, so its row lands already read: an arbiter that updates A's row changes its read_at.
  const activity = (ws: string, ids: SharedIds, writer: 0 | 1, activityType: string) => ({
    workspaceId: ws,
    activityType,
    streamId: ids.stream,
    messageId: ids.message,
    actorId: ids.persona,
    actorType: AuthorTypes.PERSONA,
    emoji: activityType === ActivityTypes.REACTION ? "👍" : null,
    isSelf: writer === 1,
  })

  const overrideValue = async (ws: string, ids: SharedIds) =>
    (
      await pool.query("SELECT value FROM user_preference_overrides WHERE workspace_id = $1 AND user_id = $2", [
        ws,
        ids.member,
      ])
    ).rows[0] ?? null

  const sharedKeyCases: Array<{
    name: string
    oldKey: string
    write: (ws: string, ids: SharedIds, writer: 0 | 1) => Promise<unknown>
    read: (ws: string, ids: SharedIds) => Promise<unknown>
  }> = [
    {
      name: "a thread anchor",
      oldKey: "idx_streams_thread_anchor_typed",
      write: (ws, ids) =>
        StreamRepository.insertThreadOrFind(pool, {
          id: streamId(),
          workspaceId: ws,
          type: StreamTypes.THREAD,
          visibility: Visibilities.PRIVATE,
          parentStreamId: ids.root,
          parentAnchorId: ids.anchor,
          rootStreamId: ids.root,
          createdBy: userId(),
        }),
      read: async (ws, ids) => (await StreamRepository.findByAnchor(pool, ws, ids.root, ids.anchor))?.id ?? null,
    },
    {
      name: "a member through insert",
      oldKey: "stream_members_pkey",
      write: (ws, ids) => StreamMemberRepository.insert(pool, ws, ids.stream, ids.member),
      read: firstRow("member_id", "stream_members"),
    },
    {
      name: "a member through insertMany",
      oldKey: "stream_members_pkey",
      write: (ws, ids) => StreamMemberRepository.insertMany(pool, ws, ids.stream, [ids.member]),
      read: firstRow("member_id", "stream_members"),
    },
    {
      name: "a sequence counter",
      oldKey: "stream_sequences_pkey",
      write: (ws, ids, writer) =>
        StreamEventRepository.allocateSequences(pool, ws, ids.stream, { total: writer + 2, broadcast: 1 }),
      read: firstRow("next_sequence, next_broadcast_sequence", "stream_sequences"),
    },
    {
      name: "a tool policy",
      oldKey: "stream_policies_pkey",
      write: (ws, ids, writer) =>
        StreamPoliciesRepository.setToolPolicy(pool, ws, ids.stream, writer === 0 ? ["web"] : ["workspace"]),
      read: (ws, ids) => StreamPoliciesRepository.getToolPolicy(pool, ws, ids.stream),
    },
    {
      name: "a brief",
      oldKey: "idx_stream_briefs_stream",
      write: (ws, ids, writer) =>
        StreamBriefRepository.insertFirstVersion(pool, {
          id: streamBriefId(),
          workspaceId: ws,
          streamId: ids.stream,
          content: `Goal ${writer}`,
          updatedByKind: AuthorTypes.USER,
          updatedById: userId(),
        }),
      read: (ws, ids) => StreamBriefRepository.findByStreamId(pool, ws, ids.stream),
    },
    {
      name: "a context bag",
      oldKey: "idx_sca_stream_intent_unique",
      write: (ws, ids, writer) =>
        ContextBagRepository.insert(pool, {
          workspaceId: ws,
          streamId: ids.stream,
          intent: ContextIntents.DISCUSS_THREAD,
          refs: [{ kind: ContextRefKinds.THREAD, streamId: ids.refStreams[writer] }],
          createdBy: userId(),
        }),
      read: (ws, ids) => ContextBagRepository.findByStream(pool, ws, ids.stream),
    },
    {
      name: "a conversation summary",
      oldKey: "idx_agent_conversation_summaries_stream_persona",
      write: (ws, ids, writer) =>
        ConversationSummaryRepository.upsert(pool, {
          id: agentConversationSummaryId(),
          workspaceId: ws,
          streamId: ids.stream,
          personaId: ids.persona,
          summary: `summary ${writer}`,
          lastSummarizedSequence: BigInt(writer + 1),
        }),
      read: (ws, ids) => ConversationSummaryRepository.findByStreamAndPersona(pool, ws, ids.stream, ids.persona),
    },
    {
      name: "a persona participation",
      oldKey: "stream_persona_participants_pkey",
      write: (ws, ids) =>
        withClient(pool, (client) =>
          StreamPersonaParticipantRepository.recordParticipation(client, ws, ids.stream, ids.persona)
        ),
      read: firstRow("persona_id", "stream_persona_participants"),
    },
    {
      name: "a client message id",
      oldKey: "messages_stream_id_client_message_id_unique",
      write: (ws, ids, writer) =>
        MessageRepository.insert(pool, {
          id: messageId(),
          workspaceId: ws,
          streamId: ids.stream,
          sequence: 1n,
          authorId: ids.member,
          authorType: AuthorTypes.USER,
          ...testMessageContent(`message ${writer}`),
          clientMessageId: ids.message,
        }),
      read: async (ws, ids) =>
        (await MessageRepository.findByClientMessageId(pool, ws, ids.stream, ids.message))?.id ?? null,
    },
    {
      name: "a reaction",
      oldKey: "reactions_pkey",
      write: (ws, ids) => MessageRepository.addReaction(pool, ws, ids.message, "👍", ids.member),
      read: firstRow("user_id, emoji", "reactions", "message"),
    },
    {
      name: "a compose trace",
      oldKey: "message_compose_traces_pkey",
      write: (ws, ids, writer) =>
        MessageComposeTraceRepository.insert(pool, {
          messageId: ids.message,
          workspaceId: ws,
          streamId: ids.stream,
          horizonStreamId: ids.stream,
          openedAt: "2026-10-03T10:00:00.000Z",
          openedAtSequence: writer,
          sentAtSequence: writer + 1,
          resumedDraft: writer === 1,
        }),
      read: (ws, ids) => MessageComposeTraceRepository.findByMessageId(pool, ws, ids.message),
    },
    {
      name: "a provisional conversation placement",
      oldKey: "message_conversation_state_pkey",
      write: (ws, ids) =>
        MessageConversationStateRepository.insertSettling(pool, {
          messageId: ids.message,
          workspaceId: ws,
          streamId: ids.stream,
          conversationId: conversationId(),
        }),
      read: (ws, ids) => MessageConversationStateRepository.findByMessageId(pool, ws, ids.message),
    },
    {
      name: "a user conversation placement",
      oldKey: "message_conversation_state_pkey",
      // Workspace A's state row stands alone: the old single-column message key keeps the same message id
      // out of messages for both workspaces, and only workspace B needs the message for its settle.
      write: async (ws, ids, writer) => {
        if (writer === 0) {
          return MessageConversationStateRepository.insertSettling(pool, {
            messageId: ids.message,
            workspaceId: ws,
            streamId: ids.stream,
            conversationId: conversationId(),
          })
        }
        await MessageRepository.insert(pool, {
          id: ids.message,
          workspaceId: ws,
          streamId: ids.stream,
          sequence: 1n,
          authorId: ids.member,
          authorType: AuthorTypes.USER,
          ...testMessageContent("settled by hand"),
        })
        return MessageConversationStateRepository.settleForConversationTargets(
          pool,
          ws,
          [ids.message],
          conversationId(),
          "user"
        )
      },
      read: (ws, ids) => MessageConversationStateRepository.findByMessageId(pool, ws, ids.message),
    },
    {
      name: "an attachment reference",
      oldKey: "attachment_references_pair_idx",
      write: (ws, ids) =>
        AttachmentReferenceRepository.insertMany(pool, [
          {
            id: attachmentReferenceId(),
            workspaceId: ws,
            attachmentId: ids.attachment,
            messageId: ids.message,
            streamId: ids.stream,
          },
        ]),
      read: firstRow("id", "attachment_references", "attachment"),
    },
    {
      name: "a video transcode job",
      oldKey: "video_transcode_jobs_attachment_id_key",
      write: async (ws, ids) => {
        const job = await VideoTranscodeJobRepository.upsert(pool, {
          id: videoTranscodeJobId(),
          workspaceId: ws,
          attachmentId: ids.attachment,
        })
        await VideoTranscodeJobRepository.updateSubmitted(pool, ws, job.id, "mc_1")
      },
      read: firstRow("id, status, mediaconvert_job_id", "video_transcode_jobs", "attachment"),
    },
    {
      name: "a read watermark through advance",
      oldKey: "stream_read_state_pkey",
      write: async (ws, ids, writer) => {
        await ownStream(ws, ids, writer)
        return ReadStateRepository.advance(pool, ws, ids.stream, ids.member, ids.events[writer], { holdInInbox: false })
      },
      read: firstRow("last_read_event_id", "stream_read_state"),
    },
    {
      name: "a read watermark through set",
      oldKey: "stream_read_state_pkey",
      write: async (ws, ids, writer) => {
        await ownStream(ws, ids, writer)
        return ReadStateRepository.set(pool, ws, ids.stream, ids.member, ids.events[writer])
      },
      read: firstRow("last_read_event_id", "stream_read_state"),
    },
    {
      name: "a read watermark through batchAdvance",
      oldKey: "stream_read_state_pkey",
      write: async (ws, ids, writer) => {
        await ownStream(ws, ids, writer)
        return ReadStateRepository.batchAdvance(pool, ws, ids.member, new Map([[ids.stream, ids.events[writer]]]))
      },
      read: firstRow("last_read_event_id", "stream_read_state"),
    },
    {
      name: "a read watermark through ensureForUpdate",
      oldKey: "stream_read_state_pkey",
      write: async (ws, ids, writer) => {
        await ownStream(ws, ids, writer)
        return ReadStateRepository.ensureForUpdate(pool, ws, ids.stream, ids.member)
      },
      read: firstRow("last_read_event_id", "stream_read_state"),
    },
    {
      name: "a read watermark through ensureBatchForUpdate",
      oldKey: "stream_read_state_pkey",
      write: async (ws, ids, writer) => {
        await ownStream(ws, ids, writer)
        return ReadStateRepository.ensureBatchForUpdate(pool, ws, ids.member, [ids.stream])
      },
      read: firstRow("last_read_event_id", "stream_read_state"),
    },
    {
      name: "a read watermark through setForUsers",
      oldKey: "stream_read_state_pkey",
      write: async (ws, ids, writer) => {
        await ownStream(ws, ids, writer)
        return ReadStateRepository.setForUsers(pool, ws, ids.stream, [ids.member], ids.events[writer])
      },
      read: firstRow("last_read_event_id", "stream_read_state"),
    },
    {
      name: "a sparse message read",
      oldKey: "stream_member_message_reads_pkey",
      write: async (ws, ids, writer) => {
        // The old event keys still span workspaces, so each workspace's event takes its own id and sequence.
        await pool.query(
          `INSERT INTO stream_events (id, workspace_id, stream_id, sequence, event_type, payload, actor_id, actor_type)
           VALUES ($1, $2, $3, $4, 'message_created', $5, $6, 'user')`,
          [ids.events[writer], ws, ids.stream, writer + 1, JSON.stringify({ messageId: ids.message }), ids.member]
        )
        return SparseReadRepository.insertReads(pool, {
          workspaceId: ws,
          streamId: ids.stream,
          memberId: ids.member,
          messageIds: [ids.message],
        })
      },
      read: firstRow("event_id", "stream_member_message_reads"),
    },
    {
      name: "a hidden board conversation",
      oldKey: "board_hidden_conversations_pkey",
      write: (ws, ids) =>
        BoardExclusionRepository.hideConversation(pool, {
          workspaceId: ws,
          conversationId: ids.conversation,
          userId: ids.member,
        }),
      read: firstRow("hidden_at", "board_hidden_conversations", "conversation"),
    },
    {
      name: "a muted board stream",
      oldKey: "board_muted_streams_pkey",
      write: (ws, ids) =>
        BoardExclusionRepository.muteStream(pool, { workspaceId: ws, streamId: ids.stream, userId: ids.member }),
      read: firstRow("user_id", "board_muted_streams"),
    },
    {
      name: "a reaction activity through insert",
      oldKey: "idx_user_activity_dedup_reaction",
      write: (ws, ids, writer) =>
        ActivityRepository.insert(pool, { ...activity(ws, ids, writer, ActivityTypes.REACTION), userId: ids.member }),
      read: firstRow("activity_type, read_at", "user_activity", "message"),
    },
    {
      name: "a reaction activity through insertBatch",
      oldKey: "idx_user_activity_dedup_reaction",
      write: (ws, ids, writer) =>
        ActivityRepository.insertBatch(pool, {
          ...activity(ws, ids, writer, ActivityTypes.REACTION),
          userIds: [ids.member],
        }),
      read: firstRow("activity_type, read_at", "user_activity", "message"),
    },
    {
      name: "a mention activity through insert",
      oldKey: "idx_user_activity_dedup_non_reaction",
      write: (ws, ids, writer) =>
        ActivityRepository.insert(pool, { ...activity(ws, ids, writer, ActivityTypes.MENTION), userId: ids.member }),
      read: firstRow("activity_type, read_at", "user_activity", "message"),
    },
    {
      name: "a mention activity through insertBatch",
      oldKey: "idx_user_activity_dedup_non_reaction",
      write: (ws, ids, writer) =>
        ActivityRepository.insertBatch(pool, {
          ...activity(ws, ids, writer, ActivityTypes.MENTION),
          userIds: [ids.member],
        }),
      read: firstRow("activity_type, read_at", "user_activity", "message"),
    },
    {
      name: "a preference override through setOverride",
      oldKey: "user_preference_overrides_pkey",
      write: (ws, ids, writer) =>
        UserPreferencesRepository.setOverride(pool, ws, ids.member, "theme", `theme ${writer}`),
      read: overrideValue,
    },
    {
      name: "a preference override through bulkSetOverrides",
      oldKey: "user_preference_overrides_pkey",
      write: (ws, ids, writer) =>
        UserPreferencesRepository.bulkSetOverrides(pool, ws, ids.member, [{ key: "theme", value: `theme ${writer}` }]),
      read: overrideValue,
    },
  ]

  // While the old keys exist, workspace B's write for a shared id is rejected by the old key. An arbiter still
  // on the old key would instead take the conflict path: update A's row or drop B's write without an error.
  for (const { name, oldKey, write, read } of sharedKeyCases) {
    test(`should leave workspace A's row untouched when workspace B writes ${name} for the same ids`, async () => {
      const wsA = workspaceId()
      const wsB = workspaceId()
      const ids: SharedIds = {
        root: streamId(),
        anchor: messageId(),
        stream: streamId(),
        member: userId(),
        persona: personaId(),
        message: messageId(),
        attachment: attachmentId(),
        conversation: conversationId(),
        refStreams: [streamId(), streamId()],
        events: [eventId(), eventId()],
      }

      await write(wsA, ids, 0)
      const seededA = await read(wsA, ids)
      const rejectedBy = await write(wsB, ids, 1).then(
        () => null,
        (error: { code?: string; constraint?: string }) => {
          if (error.code !== "23505") throw error
          return error.constraint
        }
      )
      const storedB = await read(wsB, ids)

      expect({
        a: await read(wsA, ids),
        b: rejectedBy ?? (storedB === null ? "dropped silently" : "landed"),
      }).toEqual({ a: seededA, b: oldKey })
    })
  }
})
