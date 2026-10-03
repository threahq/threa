import { describe, it, expect } from "vitest"
import Dexie from "dexie"
import { withoutWorkspace } from "@/test/workspace-rows"
import {
  ThreaDatabase,
  type CachedBoardHiddenConversation,
  type CachedBoardPost,
  type CachedConversationMessage,
  type CachedStreamContextItem,
} from "./database"

const V48_CONVERSATIONS = "id, workspaceId, [workspaceId+_lastActivityMs], _cachedAt, *conversation.messageIds"
const V38_BOARD_HIDDEN = "id, workspaceId, [workspaceId+hiddenAt]"
const V46_CONVERSATION_MESSAGES = "messageId, conversationId, workspaceId"
const V45_STREAM_CONTEXT_ITEMS =
  "key, workspaceId, streamId, rootStreamId, [workspaceId+sourceMessageId], [rootStreamId+occurredAt], [streamId+occurredAt], [groupRef+occurredAt]"

const LEGACY_STORES = ["conversations", "conversationMessages", "boardHiddenConversations", "streamContextItems"]

function cachedPost(id: string, workspaceId: string, messageIds: string[], lastActivityMs: number): CachedBoardPost {
  return {
    id,
    workspaceId,
    conversation: { id, workspaceId, streamId: "stream_1", messageIds },
    _lastActivityMs: lastActivityMs,
    _cachedAt: 1000,
  } as unknown as CachedBoardPost
}

function cachedMessage(messageId: string, workspaceId: string, conversationId: string): CachedConversationMessage {
  return {
    id: messageId,
    messageId,
    conversationId,
    workspaceId,
    streamId: "stream_1",
    authorId: "usr_1",
    authorType: "user",
    contentMarkdown: `body ${messageId} in ${workspaceId}`,
    reactions: {},
    attachments: [],
    linkPreviews: [],
    createdAt: "2026-08-20T10:00:00.000Z",
    editedAt: null,
    _cachedAt: 1000,
  }
}

function cachedHidden(id: string, workspaceId: string): CachedBoardHiddenConversation {
  return { id, workspaceId, hiddenAt: 500, _cachedAt: 1000 }
}

function cachedContextItem(
  key: string,
  workspaceId: string,
  overrides: Partial<CachedStreamContextItem> = {}
): CachedStreamContextItem {
  return {
    key,
    workspaceId,
    category: "link",
    refKind: "url",
    anchorEventId: null,
    refId: "https://example.com/a",
    groupKey: "https://example.com/a",
    groupRef: "link:https://example.com/a",
    streamId: "stream_1",
    rootStreamId: "stream_1",
    sourceMessageId: "msg_1",
    authorId: "usr_1",
    occurredAt: "2026-08-20T10:00:00.000Z",
    sequence: "1",
    snippet: `in ${workspaceId}`,
    occurrenceCount: 1,
    detail: {
      url: "https://example.com/a",
      title: null,
      description: null,
      siteName: null,
      faviconUrl: null,
      imageUrl: null,
      previewType: null,
      contentType: null,
      previewStatus: null,
    },
    _cachedAt: 1000,
    ...overrides,
  }
}

async function seedV52(name: string, seed: (legacy: Dexie) => Promise<void>): Promise<void> {
  const legacy = new Dexie(name)
  legacy.version(53).stores({
    conversations: V48_CONVERSATIONS,
    conversationMessages: V46_CONVERSATION_MESSAGES,
    boardHiddenConversations: V38_BOARD_HIDDEN,
    streamContextItems: V45_STREAM_CONTEXT_ITEMS,
  })
  await legacy.open()
  await seed(legacy)
  legacy.close()
}

describe("v54 conversations, conversation messages, hidden conversations and stream context keyed by workspace", () => {
  it("should carry rows that name a workspace to the new keys and drop the rest when upgrading from v53", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const postTwo = cachedPost("conv_2", "ws_1", ["msg_c"], 20)
    const postOne = cachedPost("conv_1", "ws_1", ["msg_a", "msg_b"], 10)
    const postOther = cachedPost("conv_3", "ws_2", ["msg_d"], 30)
    const postOrphan = cachedPost("conv_orphan", "ws_1", ["msg_x"], 40)

    const messageTwo = cachedMessage("msg_b", "ws_1", "conv_1")
    const messageOne = cachedMessage("msg_a", "ws_1", "conv_1")
    const messageOther = cachedMessage("msg_d", "ws_2", "conv_3")
    const messageOrphan = cachedMessage("msg_orphan", "ws_1", "conv_1")

    const hiddenOne = cachedHidden("conv_1", "ws_1")
    const hiddenOther = cachedHidden("conv_3", "ws_2")
    const hiddenOrphan = cachedHidden("conv_orphan", "ws_1")

    const contextTwo = cachedContextItem("link:a:msg_2", "ws_1", {
      sourceMessageId: "msg_2",
      occurredAt: "2026-08-21T10:00:00.000Z",
    })
    const contextOne = cachedContextItem("link:a:msg_1", "ws_1")
    const contextOther = cachedContextItem("link:b:msg_4", "ws_2", { rootStreamId: "stream_9", streamId: "stream_9" })
    const contextOrphan = cachedContextItem("link:a:msg_orphan", "ws_1", { sourceMessageId: "msg_orphan" })

    await seedV52(name, async (legacy) => {
      await legacy.table("conversations").bulkPut([postTwo, postOther, postOne, withoutWorkspace(postOrphan)])
      await legacy
        .table("conversationMessages")
        .bulkPut([messageTwo, messageOther, messageOne, withoutWorkspace(messageOrphan)])
      await legacy.table("boardHiddenConversations").bulkPut([hiddenOther, hiddenOne, withoutWorkspace(hiddenOrphan)])
      await legacy
        .table("streamContextItems")
        .bulkPut([contextTwo, contextOther, contextOne, withoutWorkspace(contextOrphan)])
    })

    const db = new ThreaDatabase(name)
    await db.open()

    expect({
      conversations: await db.conversations.toArray(),
      conversationByKey: await db.conversations.get(["ws_1", "conv_1"]),
      conversationsByActivity: await db.conversations
        .where("[workspaceId+_lastActivityMs]")
        .between(["ws_1", Dexie.minKey], ["ws_1", Dexie.maxKey])
        .reverse()
        .toArray(),
      conversationsInWorkspace: await db.conversations.where("workspaceId").equals("ws_1").toArray(),
      conversationsByMember: await db.conversations.where("conversation.messageIds").equals("msg_c").toArray(),
      conversationOrphan: await db.conversations.get(["ws_1", "conv_orphan"]),

      conversationMessages: await db.conversationMessages.toArray(),
      messageByKey: await db.conversationMessages.get(["ws_1", "msg_a"]),
      messagesByConversation: await db.conversationMessages
        .where("[workspaceId+conversationId]")
        .equals(["ws_1", "conv_1"])
        .toArray(),
      messageOrphan: await db.conversationMessages.get(["ws_1", "msg_orphan"]),

      hidden: await db.boardHiddenConversations.toArray(),
      hiddenByKey: await db.boardHiddenConversations.get(["ws_2", "conv_3"]),
      hiddenInWorkspace: await db.boardHiddenConversations.where("workspaceId").equals("ws_1").toArray(),
      hiddenOrphan: await db.boardHiddenConversations.get(["ws_1", "conv_orphan"]),

      context: await db.streamContextItems.toArray(),
      contextByKey: await db.streamContextItems.get(["ws_1", "link:a:msg_2"]),
      contextByRoot: await db.streamContextItems
        .where("[workspaceId+rootStreamId+occurredAt]")
        .between(["ws_1", "stream_1", Dexie.minKey], ["ws_1", "stream_1", Dexie.maxKey])
        .reverse()
        .toArray(),
      contextByStream: await db.streamContextItems
        .where("[workspaceId+streamId+occurredAt]")
        .between(["ws_2", "stream_9", Dexie.minKey], ["ws_2", "stream_9", Dexie.maxKey])
        .toArray(),
      contextByGroup: await db.streamContextItems
        .where("[workspaceId+groupRef+occurredAt]")
        .between(
          ["ws_1", "link:https://example.com/a", Dexie.minKey],
          ["ws_1", "link:https://example.com/a", Dexie.maxKey]
        )
        .toArray(),
      contextBySourceMessage: await db.streamContextItems
        .where("[workspaceId+sourceMessageId]")
        .equals(["ws_1", "msg_2"])
        .toArray(),
      contextOrphan: await db.streamContextItems.get(["ws_1", "link:a:msg_orphan"]),

      legacyStores: db.tables.map((table) => table.name).filter((tableName) => LEGACY_STORES.includes(tableName)),
    }).toEqual({
      conversations: [postOne, postTwo, postOther],
      conversationByKey: postOne,
      conversationsByActivity: [postTwo, postOne],
      conversationsInWorkspace: [postOne, postTwo],
      conversationsByMember: [postTwo],
      conversationOrphan: undefined,

      conversationMessages: [messageOne, messageTwo, messageOther],
      messageByKey: messageOne,
      messagesByConversation: [messageOne, messageTwo],
      messageOrphan: undefined,

      hidden: [hiddenOne, hiddenOther],
      hiddenByKey: hiddenOther,
      hiddenInWorkspace: [hiddenOne],
      hiddenOrphan: undefined,

      context: [contextOne, contextTwo, contextOther],
      contextByKey: contextTwo,
      contextByRoot: [contextTwo, contextOne],
      contextByStream: [contextOther],
      contextByGroup: [contextOne, contextTwo],
      contextBySourceMessage: [contextTwo],
      contextOrphan: undefined,

      legacyStores: [],
    })

    db.close()
    await Dexie.delete(name)
  })

  it("should keep the same conversation id, message id and context key separate per workspace when written after the upgrade", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const postA = cachedPost("conv_copied", "ws_a", ["msg_copied"], 10)
    const postB = cachedPost("conv_copied", "ws_b", ["msg_copied"], 20)
    const messageA = cachedMessage("msg_copied", "ws_a", "conv_copied")
    const messageB = cachedMessage("msg_copied", "ws_b", "conv_copied")
    const hiddenA = cachedHidden("conv_copied", "ws_a")
    const hiddenB = cachedHidden("conv_copied", "ws_b")
    const contextA = cachedContextItem("link:a:msg_copied", "ws_a", { sourceMessageId: "msg_copied" })
    const contextB = cachedContextItem("link:a:msg_copied", "ws_b", { sourceMessageId: "msg_copied" })

    await seedV52(name, async (legacy) => {
      await legacy.table("conversations").put(postA)
      await legacy.table("conversationMessages").put(messageA)
      await legacy.table("boardHiddenConversations").put(hiddenA)
      await legacy.table("streamContextItems").put(contextA)
    })

    const db = new ThreaDatabase(name)
    await db.open()
    await db.conversations.put(postB)
    await db.conversationMessages.put(messageB)
    await db.boardHiddenConversations.put(hiddenB)
    await db.streamContextItems.put(contextB)

    const both = {
      conversations: await db.conversations.toArray(),
      conversationMessages: await db.conversationMessages.toArray(),
      hidden: await db.boardHiddenConversations.toArray(),
      context: await db.streamContextItems.toArray(),
    }

    await db.conversations.delete(["ws_a", "conv_copied"])
    await db.conversationMessages.delete(["ws_a", "msg_copied"])
    await db.boardHiddenConversations.delete(["ws_a", "conv_copied"])
    await db.streamContextItems.delete(["ws_a", "link:a:msg_copied"])

    expect({
      both,
      afterDeletingA: {
        conversations: await db.conversations.toArray(),
        conversationMessages: await db.conversationMessages.toArray(),
        hidden: await db.boardHiddenConversations.toArray(),
        context: await db.streamContextItems.toArray(),
      },
    }).toEqual({
      both: {
        conversations: [postA, postB],
        conversationMessages: [messageA, messageB],
        hidden: [hiddenA, hiddenB],
        context: [contextA, contextB],
      },
      afterDeletingA: {
        conversations: [postB],
        conversationMessages: [messageB],
        hidden: [hiddenB],
        context: [contextB],
      },
    })

    db.close()
    await Dexie.delete(name)
  })
})
