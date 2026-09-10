import { afterEach, beforeEach, describe, expect, it } from "vitest"
import Dexie from "dexie"
import { renderHook, waitFor } from "@testing-library/react"
import type { CachedBoardPost, CachedEvent, CachedStream } from "@/db"
import { ThreaDatabase, accountDbName, getActiveDb, setActiveDb } from "@/db/database"
import { useBoardCardMessages, __clearBoardRailRegistry } from "@/hooks/use-board-card-messages"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { useConversationGraph, __clearConversationGraphRegistry } from "@/hooks/use-conversation-graph"
import { useScopeDraftPreview, __clearBoardDraftsRegistry } from "@/hooks/use-scope-draft-preview"
import {
  getWorkspaceTableSnapshot,
  subscribeWorkspaceTable,
  resetWorkspaceTableRegistry,
} from "@/stores/workspace-table-registry"
import {
  hasSeededWorkspaceCache,
  resetWorkspaceStoreCache,
  seedCacheFromIdb,
  getCachedWorkspaceTables,
} from "@/stores/workspace-store"

/**
 * Two accounts, one workspace, one stream. Everything below is the same key
 * under both accounts — which is the point: the shared Dexie registries are
 * keyed by stream/workspace id, so only the account database they read from
 * tells them apart.
 */
const WS = "ws_shared"
const STREAM = "stream_shared"
const SCOPE = "board:reply:conv_1"

const ACCOUNT_A = "user_a"
const ACCOUNT_B = "user_b"

let dbA: ThreaDatabase
let dbB: ThreaDatabase
let originalDb: ThreaDatabase

function event(id: string, contentMarkdown: string, streamId = STREAM): CachedEvent {
  return {
    id: `evt_${id}_${streamId}`,
    workspaceId: WS,
    streamId,
    sequence: "1",
    _sequenceNum: 1,
    eventType: "message_created",
    payload: { messageId: id, contentMarkdown, reactions: {} },
    actorId: "usr_1",
    actorType: "user",
    createdAt: "2026-03-01T10:00:00Z",
    _cachedAt: 1,
  } as CachedEvent
}

function makePost(messageIds: string[], openingId: string): BoardViewPost {
  return {
    id: "conv_1",
    workspaceId: WS,
    _lastActivityMs: 0,
    _cachedAt: 0,
    streamIds: [STREAM],
    conversation: { id: "conv_1", streamId: STREAM, messageIds, lastActivityAt: "2026-03-01T10:00:00Z" },
    openingMessage: {
      id: openingId,
      streamId: STREAM,
      authorId: "usr_1",
      authorType: "user",
      contentMarkdown: "server projection",
      reactions: {},
      attachments: [],
      linkPreviews: [],
      createdAt: "2026-03-01T10:00:00Z",
    },
    recentMessages: [],
    totalReplies: messageIds.length - (messageIds[0] === openingId ? 1 : 0),
  } as unknown as BoardViewPost
}

function thread(id: string, parentMessageId: string): CachedStream {
  return {
    id,
    workspaceId: WS,
    type: "thread",
    parentStreamId: STREAM,
    parentMessageId,
    parentAnchorId: null,
    rootStreamId: STREAM,
    _cachedAt: 1,
  } as CachedStream
}

function conversation(id: string, topicSummary: string): CachedBoardPost {
  return {
    id,
    workspaceId: WS,
    rootStreamId: STREAM,
    conversation: { id, streamId: `stream_${id}`, messageIds: [], topicSummary, parentConversationId: null },
  } as unknown as CachedBoardPost
}

function workspaceRow() {
  return {
    id: WS,
    name: "Shared",
    slug: "shared",
    createdAt: "2026-03-01T10:00:00Z",
    updatedAt: "2026-03-01T10:00:00Z",
    _cachedAt: 1,
  }
}

function userRow() {
  return {
    id: "usr_a",
    workspaceId: WS,
    workosUserId: ACCOUNT_A,
    email: "a@example.com",
    role: "member",
    slug: "a",
    name: "Account A",
    _cachedAt: 1,
  } as never
}

function draftRow(id: string, text: string) {
  return {
    id,
    workspaceId: WS,
    scope: SCOPE,
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    attachments: [],
    clientUpdatedAt: 1,
  }
}

/** What an account switch does to this layer: repoint the shared `db` handle. */
function switchTo(database: ThreaDatabase): void {
  setActiveDb(database)
}

beforeEach(async () => {
  originalDb = getActiveDb()
  dbA = new ThreaDatabase(accountDbName(ACCOUNT_A), ACCOUNT_A)
  dbB = new ThreaDatabase(accountDbName(ACCOUNT_B), ACCOUNT_B)
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
  __clearBoardDraftsRegistry()
  resetWorkspaceTableRegistry()
  resetWorkspaceStoreCache()
  switchTo(dbA)
})

afterEach(async () => {
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
  __clearBoardDraftsRegistry()
  resetWorkspaceTableRegistry()
  resetWorkspaceStoreCache()
  setActiveDb(originalDb)
  for (const database of [dbA, dbB]) {
    database.close()
    await Dexie.delete(database.name)
  }
})

describe("shared Dexie registries across an account switch", () => {
  it("does not hand the next account the previous account's card messages, thread rails included", async () => {
    await dbA.events.bulkPut([event("m1", "A's opening"), event("r1", "A's thread reply", "stream_thread_a")])
    await dbA.streams.put(thread("stream_thread_a", "m1"))
    // Same message id, same stream, different account — the sharpest form of
    // the shared key: only the database distinguishes the two rows.
    await dbB.events.put(event("m1", "B's opening"))

    const post = makePost(["m1", "r1"], "m1")
    const a = renderHook(() => useBoardCardMessages(post))
    await waitFor(() => expect(a.result.current.openingMessage?.contentMarkdown).toBe("A's opening"))
    await waitFor(() => expect(a.result.current.replies.map((m) => m.id)).toEqual(["r1"]))
    // The rail's 5s teardown grace outlives the switch, so A's entries are still
    // in memory when B mounts — the exact window the id-only key leaked through.
    a.unmount()

    switchTo(dbB)
    const b = renderHook(() => useBoardCardMessages(post))
    await waitFor(() => expect(b.result.current.openingMessage?.contentMarkdown).toBe("B's opening"))
    expect(b.result.current.replies.map((m) => m.id)).toEqual([])
    b.unmount()
  })

  it("does not hand the next account the previous account's conversation graph", async () => {
    await dbA.conversations.put(conversation("conv_a", "account A topic"))

    const a = renderHook(() => useConversationGraph(WS))
    await waitFor(() => expect(a.result.current.conversationById.size).toBe(1))

    switchTo(dbB)
    const b = renderHook(() => useConversationGraph(WS))
    expect(b.result.current.conversationById.size).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(b.result.current.conversationById.has("conv_a")).toBe(false)

    a.unmount()
    b.unmount()
  })

  it("does not hand the next account the previous account's draft preview", async () => {
    await dbA.drafts.put(draftRow("draft_a", "account A's unsent words"))

    const a = renderHook(() => useScopeDraftPreview(WS, SCOPE))
    await waitFor(() => expect(a.result.current?.preview).toBe("account A's unsent words"))

    switchTo(dbB)
    const b = renderHook(() => useScopeDraftPreview(WS, SCOPE))
    expect(b.result.current).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(b.result.current).toBeNull()

    a.unmount()
    b.unmount()
  })

  it("does not hand the next account the previous account's workspace table rows", async () => {
    await dbA.workspaces.put(workspaceRow())
    await dbB.workspaces.put({ ...workspaceRow(), name: "B's copy" })

    const unsubscribeA = subscribeWorkspaceTable(WS, "workspace", () => {})
    await waitFor(() => expect(getWorkspaceTableSnapshot(WS, "workspace")?.[0]?.name).toBe("Shared"))

    switchTo(dbB)
    // B reads its own entry: unresolved until its own first emission, never A's rows.
    expect(getWorkspaceTableSnapshot(WS, "workspace")).toBeUndefined()
    const unsubscribeB = subscribeWorkspaceTable(WS, "workspace", () => {})
    await waitFor(() => expect(getWorkspaceTableSnapshot(WS, "workspace")?.[0]?.name).toBe("B's copy"))

    // A's cleanup runs after B mounted (React unmounts the outgoing subtree
    // last). It must retire A's entry, not the replacement under the same key.
    unsubscribeA()
    expect(getWorkspaceTableSnapshot(WS, "workspace")?.[0]?.name).toBe("B's copy")
    unsubscribeB()
  })
})

describe("seedCacheFromIdb ownership", () => {
  it("never publishes a read that started under another account", async () => {
    await dbA.workspaces.put(workspaceRow())
    await dbA.workspaceUsers.put(userRow())

    // The switch lands while the IDB reads are in flight. `cacheVersion` is
    // cleared per account, so it reads 0 before and after (ABA) — only the
    // captured database tells the seed its account moved on.
    const pending = seedCacheFromIdb(WS)
    switchTo(dbB)
    resetWorkspaceStoreCache()

    expect(await pending).toBe(false)
    expect(hasSeededWorkspaceCache(WS)).toBe(false)
    expect(getCachedWorkspaceTables(WS).users).toBeUndefined()
  })

  it("publishes a read that stayed with its account", async () => {
    await dbA.workspaces.put(workspaceRow())
    await dbA.workspaceUsers.put(userRow())

    expect(await seedCacheFromIdb(WS)).toBe(true)
    expect(getCachedWorkspaceTables(WS).users?.map((u) => u.name)).toEqual(["Account A"])
  })
})
