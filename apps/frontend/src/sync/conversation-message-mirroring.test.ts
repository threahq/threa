import { describe, it, expect, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Socket } from "socket.io-client"
import type { BoardPostMessage, LinkPreviewSummary } from "@threa/types"
import { db } from "@/db"
import { registerStreamSocketHandlers } from "./stream-sync"
import { seedConversationMessages, __resetConversationMessageSnapshots } from "@/stores/conversation-messages-store"

const WS = "ws_1"
const STREAM = "stream_mirror"
const CONV = "conv_mirror"

function createTestSocket() {
  const handlers = new Map<string, Set<(payload: unknown) => void | Promise<void>>>()
  const socket = {
    on(event: string, handler: (payload: unknown) => void) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return this
    },
    off(event: string, handler: (payload: unknown) => void) {
      handlers.get(event)?.delete(handler)
      return this
    },
  } as unknown as Socket
  return {
    socket,
    async emit(event: string, payload: unknown) {
      await Promise.all(Array.from(handlers.get(event) ?? []).map((handler) => handler(payload)))
    },
  }
}

function message(id: string): BoardPostMessage {
  return {
    id,
    streamId: STREAM,
    authorId: "usr_1",
    authorType: "user",
    contentMarkdown: `body ${id}`,
    reactions: {},
    attachments: [],
    linkPreviews: [],
    createdAt: "2026-07-01T10:00:00.000Z",
    editedAt: null,
  }
}

async function row(messageId: string) {
  const cached = await db.conversationMessages.get(messageId)
  if (!cached) return null
  const { _cachedAt, ...rest } = cached
  return rest
}

const cachedShape = (overrides: Partial<BoardPostMessage> = {}) => ({
  ...message("m1"),
  ...overrides,
  messageId: "m1",
  conversationId: CONV,
  workspaceId: WS,
})

let emit: ReturnType<typeof createTestSocket>["emit"]
let cleanup: () => void

beforeEach(async () => {
  await db.events.clear()
  await db.conversationMessages.clear()
  __resetConversationMessageSnapshots()
  cleanup?.()
  const testSocket = createTestSocket()
  emit = testSocket.emit
  cleanup = registerStreamSocketHandlers(testSocket.socket, WS, STREAM, new QueryClient())
  await seedConversationMessages(WS, CONV, [message("m1")])
})

describe("live patches mirror onto the conversation backfill store", () => {
  it("applies message:edited", async () => {
    await emit("message:edited", {
      workspaceId: WS,
      streamId: STREAM,
      event: {
        id: "evt_edit",
        streamId: STREAM,
        sequence: "2",
        eventType: "message_edited",
        createdAt: "2026-07-02T10:00:00.000Z",
        payload: { messageId: "m1", contentJson: null, contentMarkdown: "edited body" },
      },
    })

    expect(await row("m1")).toEqual(
      cachedShape({ contentMarkdown: "edited body", editedAt: "2026-07-02T10:00:00.000Z" })
    )
  })

  it("applies message:deleted", async () => {
    await emit("message:deleted", {
      workspaceId: WS,
      streamId: STREAM,
      messageId: "m1",
      deletedAt: "2026-07-03T10:00:00.000Z",
    })

    expect(await row("m1")).toEqual(cachedShape({ deletedAt: "2026-07-03T10:00:00.000Z" }))
  })

  it("applies reaction:added then reaction:removed", async () => {
    const reaction = { workspaceId: WS, streamId: STREAM, messageId: "m1", emoji: "👍", userId: "usr_2" }
    await emit("reaction:added", reaction)
    expect(await row("m1")).toEqual(cachedShape({ reactions: { "👍": ["usr_2"] } }))

    await emit("reaction:removed", reaction)
    expect(await row("m1")).toEqual(cachedShape({ reactions: {} }))
  })

  it("applies link_preview:ready", async () => {
    const previews: LinkPreviewSummary[] = [
      {
        id: "lp_1",
        position: 0,
        url: "https://example.com",
        title: "Example",
        description: null,
        siteName: null,
        faviconUrl: null,
        imageUrl: null,
        previewType: null,
        contentType: "website",
      },
    ]
    await emit("link_preview:ready", { workspaceId: WS, streamId: STREAM, messageId: "m1", previews })

    expect(await row("m1")).toEqual(cachedShape({ linkPreviews: previews }))
  })

  it("is a no-op for a message that isn't backfilled", async () => {
    await emit("message:deleted", {
      workspaceId: WS,
      streamId: STREAM,
      messageId: "m_absent",
      deletedAt: "2026-07-03T10:00:00.000Z",
    })

    expect(await db.conversationMessages.toArray()).toHaveLength(1)
    expect(await row("m1")).toEqual(cachedShape())
  })
})
