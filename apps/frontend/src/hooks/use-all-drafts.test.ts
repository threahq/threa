import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import type { JSONContent } from "@threa/types"
import { db, type CachedDraft } from "@/db"
import { resetDraftStoreCache } from "@/stores/draft-store"
import { seedDecryption, clearDecryptCache } from "@/lib/crypto/decrypt-cache"
import * as syncEngineModule from "@/sync/sync-engine"
import * as currentUserHook from "./use-current-workspace-user-id"
import * as e2eSessionStore from "@/stores/e2e-session-store"
import {
  streamIdsWithLoadedDraft,
  useAllDrafts,
  useDraftSummary,
  type DraftType,
  type UnifiedDraft,
} from "./use-all-drafts"

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
const UNLOCKED_SESSION = {
  status: "unlocked",
  keyId: "ek_1",
  publicKey: null,
  privateKey: {} as CryptoKey,
  deviceTrusted: true,
  error: null,
} as ReturnType<typeof e2eSessionStore.useE2eSession>

const workspaceId = "ws_1"

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})

function syncedDraft(overrides: Partial<CachedDraft> = {}): CachedDraft {
  return {
    id: "draft_s1",
    workspaceId,
    scope: "stream:stream_1",
    contentJson: makeDoc("a synced draft"),
    attachments: [],
    clientUpdatedAt: 1000,
    // Confirmed by the server at least once, so a local delete must mirror up.
    baseVersion: 2,
    ...overrides,
  }
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return { wrapper }
}

async function pendingDeleteIds(): Promise<string[]> {
  const ops = await db.pendingOperations.where("type").equals("delete_draft").toArray()
  return ops.map((op) => op.payload.draftId as string)
}

function seedStream(overrides: { id: string } & Partial<Record<string, unknown>>): Promise<unknown> {
  return db.streams.put({
    workspaceId,
    type: "channel",
    visibility: "private",
    rootStreamId: null,
    parentMessageId: null,
    archivedAt: null,
    ...overrides,
  } as never)
}

function seedMessageEvent(messageId: string, streamId: string, seq: number): Promise<unknown> {
  return db.events.put({
    id: `evt_${messageId}`,
    workspaceId,
    streamId,
    sequence: String(seq),
    _sequenceNum: seq,
    eventType: "message_created",
    payload: { messageId, contentMarkdown: "x", reactions: {} },
    actorId: "usr_1",
    actorType: "user",
    createdAt: new Date(seq).toISOString(),
    _cachedAt: seq,
  } as never)
}

beforeEach(async () => {
  vi.restoreAllMocks()
  resetDraftStoreCache()
  await db.drafts.clear()
  await db.composerLoaded.clear()
  await db.pendingOperations.clear()
  await db.draftScratchpads.clear()
  await db.conversations.clear()
  await db.streams.clear()
  await db.events.clear()
  // The drafts explorer now decrypts E2E previews via the shared cache, which
  // reads the viewer id + session; default them to "no viewer / locked" so these
  // plaintext-draft tests run without an AuthProvider (INV-48 namespace spyOn).
  vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue(null)
  vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue({
    status: "locked",
    keyId: null,
    publicKey: null,
    privateKey: null,
    deviceTrusted: false,
    error: null,
  } as ReturnType<typeof e2eSessionStore.useE2eSession>)
})

describe("useAllDrafts board-composer drafts", () => {
  async function seedConversation(
    conversationId: string,
    streamId: string,
    topicSummary: string | null,
    extra: { parentConversationId?: string; messageIds?: string[] } = {}
  ) {
    await db.conversations.put({
      id: conversationId,
      workspaceId,
      _lastActivityMs: 1,
      _cachedAt: 1,
      conversation: { id: conversationId, streamId, topicSummary, ...extra },
    } as unknown as Parameters<typeof db.conversations.put>[0])
  }

  it("lists a stashed board reply with a panel deep link that carries the stash restore", async () => {
    await seedConversation("conv_1", "stream_9", "GPU budget")
    await db.drafts.add(syncedDraft({ id: "draft_b1", scope: "board:reply:conv_1" }))

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await waitFor(() => expect(result.current.drafts).toHaveLength(1))
    expect(result.current.drafts[0]).toMatchObject({
      id: "draft_b1",
      displayName: "Reply in GPU budget",
      streamId: "stream_9",
      isStashed: true,
      href: `/w/${workspaceId}/s/stream_9?panel=${encodeURIComponent("conv:conv_1")}&stash=draft_b1`,
    })
  })

  it("lists a branch reply and a sub-topic draft, navigable but without a stash param (no mounted consumer)", async () => {
    await seedConversation("conv_2", "stream_thread_1", "Sub topic")
    await db.drafts.add(syncedDraft({ id: "draft_b2", scope: "board:branch-reply:conv_2" }))
    await db.drafts.add(syncedDraft({ id: "draft_b3", scope: "board:subtopic:stream_9:msg_1", clientUpdatedAt: 900 }))

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await waitFor(() => expect(result.current.drafts).toHaveLength(2))
    expect(result.current.drafts[0]).toMatchObject({
      id: "draft_b2",
      displayName: "Reply in Sub topic",
      href: `/w/${workspaceId}/s/stream_thread_1?panel=${encodeURIComponent("conv:conv_2")}`,
    })
    expect(result.current.drafts[1]).toMatchObject({
      id: "draft_b3",
      displayName: "New sub-topic",
      href: `/w/${workspaceId}/s/stream_9?m=msg_1`,
    })
  })

  it("still links (via the board route) while the conversation isn't cached, so roamed pickup never dead-ends", async () => {
    await db.drafts.add(syncedDraft({ id: "draft_b4", scope: "board:reply:conv_uncached" }))

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await waitFor(() => expect(result.current.drafts).toHaveLength(1))
    expect(result.current.drafts[0]).toMatchObject({
      id: "draft_b4",
      displayName: "Conversation reply",
      href: `/w/${workspaceId}/board?panel=${encodeURIComponent("conv:conv_uncached")}&stash=draft_b4`,
    })
  })

  it("deep-links a branch reply to its PARENT conversation's panel with the stash restore", async () => {
    // Parenthood is structural: the branch's anchor thread forks off a message
    // that is a member of the parent conversation (no parentConversationId).
    await seedConversation("conv_parent", "stream_9", "GPU budget", { messageIds: ["msg_fork_b"] })
    await seedConversation("conv_branch", "stream_thread_1", "Sub topic")
    await db.streams.put({
      id: "stream_thread_1",
      workspaceId,
      type: "thread",
      parentStreamId: "stream_9",
      parentMessageId: "msg_fork_b",
    } as unknown as Parameters<typeof db.streams.put>[0])
    await db.drafts.add(syncedDraft({ id: "draft_b6", scope: "board:branch-reply:conv_branch" }))

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await waitFor(() =>
      expect(result.current.drafts[0]).toMatchObject({
        id: "draft_b6",
        displayName: "Reply in Sub topic",
        href: `/w/${workspaceId}/s/stream_9?panel=${encodeURIComponent("conv:conv_parent")}&stash=draft_b6`,
      })
    )
  })

  it("deep-links a sub-topic draft to the conversation hosting its fork message, with the stash restore", async () => {
    await seedConversation("conv_host", "stream_9", "GPU budget", { messageIds: ["msg_fork"] })
    await db.drafts.add(syncedDraft({ id: "draft_b7", scope: "board:subtopic:stream_9:msg_fork" }))

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await waitFor(() =>
      expect(result.current.drafts[0]).toMatchObject({
        id: "draft_b7",
        displayName: "New sub-topic in GPU budget",
        href: `/w/${workspaceId}/s/stream_9?panel=${encodeURIComponent("conv:conv_host")}&stash=draft_b7`,
      })
    )
  })

  it("counts board drafts in the sidebar summary without flagging a stream hint", async () => {
    await db.drafts.add(syncedDraft({ id: "draft_b5", scope: "board:reply:conv_1" }))
    await db.drafts.add(syncedDraft({ id: "draft_s9", scope: "stream:stream_1" }))
    await db.composerLoaded.put({ scope: "stream:stream_1", workspaceId, draftId: "draft_s9" })

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useDraftSummary(workspaceId), { wrapper })

    await waitFor(() => expect(result.current.draftCount).toBe(2))
    expect(result.current.loadedDraftStreamIdSignature).toBe("stream_1")
  })
})

describe("useAllDrafts deleteDraft", () => {
  it("kicks the operation queue so a Drafts-view delete propagates to other devices", async () => {
    const kickOperationQueue = vi.fn()
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      kickOperationQueue,
    } as unknown as syncEngineModule.SyncEngine)

    // A synced stash draft (not the loaded one — no composerLoaded pointer).
    await db.drafts.add(syncedDraft({ id: "draft_s1" }))

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await act(async () => {
      await result.current.deleteDraft("draft_s1")
    })

    // Local row gone, a CAS-safe server delete queued, AND the queue kicked so
    // the delete drains now instead of waiting for the next reconnect (without
    // the kick the row survives server-side and every other device keeps it).
    expect(await db.drafts.get("draft_s1")).toBeUndefined()
    expect(await pendingDeleteIds()).toContain("draft_s1")
    expect(kickOperationQueue).toHaveBeenCalled()
  })

  it("kicks the queue when deleting the loaded draft too", async () => {
    const kickOperationQueue = vi.fn()
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      kickOperationQueue,
    } as unknown as syncEngineModule.SyncEngine)

    const scope = "stream:stream_2"
    await db.drafts.add(syncedDraft({ id: "draft_loaded", scope }))
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_loaded" })

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await act(async () => {
      await result.current.deleteDraft("draft_loaded")
    })

    expect(await db.drafts.get("draft_loaded")).toBeUndefined()
    // The unified delete path clears the loaded pointer too, so the composer
    // empties instead of dangling at a missing row.
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
    expect(await pendingDeleteIds()).toContain("draft_loaded")
    expect(kickOperationQueue).toHaveBeenCalled()
  })
})

describe("useAllDrafts E2E drafts", () => {
  it("lists a sealed draft with its decrypted preview instead of dropping it", async () => {
    vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue("user_1")
    vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(UNLOCKED_SESSION)
    clearDecryptCache()

    // A sealed draft at rest: ciphertext only, the empty placeholder as contentJson.
    await db.drafts.add({
      id: "draft_e2e",
      workspaceId,
      scope: "stream:stream_enc",
      contentJson: EMPTY_DOC,
      attachments: [],
      ciphertext: "ct_sealed",
      envelope: { v: 2 },
      e2eVersion: 2,
      baseVersion: 1,
      clientUpdatedAt: 2000,
    })
    // The viewer already holds the plaintext in the shared cache (seeded by the
    // authoring device's save, or a prior decrypt-on-read).
    seedDecryption("draft_e2e", { contentMarkdown: "secret body", contentJson: makeDoc("secret body") })

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await waitFor(() => expect(result.current.drafts.some((d) => d.id === "draft_e2e")).toBe(true))
    const row = result.current.drafts.find((d) => d.id === "draft_e2e")!
    // The encrypted draft shows up (not filtered out for an empty contentJson),
    // and its preview is the decrypted body — never the ciphertext or a blank.
    expect(row.preview).toBe("secret body")
    expect(row.isStashed).toBe(true)
  })

  it("shows an 'Encrypted draft' placeholder (not a blank row) while the session is locked", async () => {
    vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue("user_1")
    // Default locked session from beforeEach stands.
    clearDecryptCache()
    await db.drafts.add({
      id: "draft_locked",
      workspaceId,
      scope: "stream:stream_enc",
      contentJson: EMPTY_DOC,
      attachments: [],
      ciphertext: "ct_sealed",
      envelope: { v: 2 },
      e2eVersion: 2,
      baseVersion: 1,
      clientUpdatedAt: 2000,
    })

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await waitFor(() => expect(result.current.drafts.some((d) => d.id === "draft_locked")).toBe(true))
    expect(result.current.drafts.find((d) => d.id === "draft_locked")!.preview).toBe("Encrypted draft")
  })
})

describe("useAllDrafts archived streams", () => {
  it("hides a draft whose stream is archived and keeps one whose stream is active", async () => {
    await seedStream({ id: "stream_active" })
    await seedStream({ id: "stream_archived", archivedAt: "2026-01-01T00:00:00Z" })
    await db.drafts.bulkAdd([
      syncedDraft({ id: "draft_active", scope: "stream:stream_active", contentJson: makeDoc("keep me") }),
      syncedDraft({ id: "draft_archived", scope: "stream:stream_archived", contentJson: makeDoc("hide me") }),
    ])

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await waitFor(() => expect(result.current.drafts.map((d) => d.id)).toEqual(["draft_active"]))
  })

  it("hides a thread-reply draft whose root stream is archived, at any nesting depth", async () => {
    // root (archived) -> mid thread -> deep thread. The reply draft targets a
    // message inside the deepest thread; archival is marked only on the root.
    await seedStream({ id: "stream_root", archivedAt: "2026-01-01T00:00:00Z" })
    await seedStream({ id: "stream_mid", type: "thread", rootStreamId: "stream_root" })
    await seedStream({ id: "stream_deep", type: "thread", rootStreamId: "stream_root" })
    await seedMessageEvent("msg_deep", "stream_deep", 1)
    await db.drafts.add(syncedDraft({ id: "draft_thread", scope: "thread:msg_deep", contentJson: makeDoc("reply") }))

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    // The gated events query resolves the reply's parent stream; once it does,
    // the thread draft is hidden because its root (`stream_root`) is archived.
    await waitFor(() => expect(result.current.drafts).toHaveLength(0))
  })

  it("keeps a thread-reply draft whose root stream is active", async () => {
    await seedStream({ id: "stream_root_active" })
    await seedStream({ id: "stream_thread", type: "thread", rootStreamId: "stream_root_active" })
    await seedMessageEvent("msg_active", "stream_thread", 1)
    await db.drafts.add(
      syncedDraft({ id: "draft_thread_ok", scope: "thread:msg_active", contentJson: makeDoc("reply") })
    )

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await waitFor(() => expect(result.current.drafts.map((d) => d.id)).toEqual(["draft_thread_ok"]))
  })

  it("keeps the summary badge count in step with the hidden list for channel/DM drafts", async () => {
    await seedStream({ id: "stream_keep" })
    await seedStream({ id: "stream_gone", archivedAt: "2026-01-01T00:00:00Z" })
    await db.drafts.bulkAdd([
      syncedDraft({ id: "draft_keep", scope: "stream:stream_keep", contentJson: makeDoc("keep") }),
      syncedDraft({ id: "draft_gone", scope: "stream:stream_gone", contentJson: makeDoc("gone") }),
    ])

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => ({ summary: useDraftSummary(workspaceId), all: useAllDrafts(workspaceId) }), {
      wrapper,
    })

    await waitFor(() => expect(result.current.all.drafts.length).toBe(1))
    expect(result.current.summary.draftCount).toBe(1)
    expect(result.current.summary.draftCount).toBe(result.current.all.drafts.length)
  })

  it("badge still counts a thread draft under an archived root (deliberate: no events scan in the sidebar)", async () => {
    // The explorer resolves the thread's stream via a db.events scan and hides
    // the draft; the summary skips that scan to keep the always-mounted sidebar
    // off a query that churns on every message, so it over-counts this rare case.
    await seedStream({ id: "stream_root_arch", archivedAt: "2026-01-01T00:00:00Z" })
    await seedStream({ id: "stream_thr", type: "thread", rootStreamId: "stream_root_arch" })
    await seedMessageEvent("msg_x", "stream_thr", 1)
    await db.drafts.add(syncedDraft({ id: "draft_thr", scope: "thread:msg_x", contentJson: makeDoc("reply") }))

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => ({ summary: useDraftSummary(workspaceId), all: useAllDrafts(workspaceId) }), {
      wrapper,
    })

    // Steady state: the explorer hides it while the badge still counts it.
    // Asserted together so we read the settled state, not a co-mount transient.
    await waitFor(() => {
      expect(result.current.all.drafts).toHaveLength(0)
      expect(result.current.summary.draftCount).toBe(1)
    })
  })
})

describe("streamIdsWithLoadedDraft", () => {
  function unifiedDraft(overrides: Partial<UnifiedDraft> = {}): UnifiedDraft {
    return {
      id: "draft_1",
      type: "channel" as DraftType,
      streamId: "stream_1",
      displayName: "General",
      preview: "hello",
      attachmentCount: 0,
      updatedAt: 1000,
      href: "/w/ws_1/s/stream_1",
      groupLabel: "General",
      isStashed: false,
      ...overrides,
    }
  }

  it("includes streams with a loaded draft but excludes stashed ones", () => {
    const ids = streamIdsWithLoadedDraft([
      unifiedDraft({ id: "draft_loaded", streamId: "stream_loaded", isStashed: false }),
      unifiedDraft({ id: "draft_stashed", streamId: "stream_stashed", isStashed: true }),
    ])
    expect(ids).toEqual(new Set(["stream_loaded"]))
  })

  it("does not flag a stream whose only draft for the scope is stashed", () => {
    const ids = streamIdsWithLoadedDraft([
      unifiedDraft({ id: "draft_a", streamId: "stream_x", isStashed: true }),
      unifiedDraft({ id: "draft_b", streamId: "stream_x", isStashed: true }),
    ])
    expect(ids.has("stream_x")).toBe(false)
  })

  it("excludes thread replies and scratchpads — only a stream's own composer draft counts", () => {
    const ids = streamIdsWithLoadedDraft([
      unifiedDraft({ id: "draft_thread", type: "thread", streamId: "stream_parent" }),
      unifiedDraft({ id: "draft_scratch", type: "scratchpad", streamId: "draft_scratchpad_1" }),
      unifiedDraft({ id: "draft_dm", type: "dm", streamId: "stream_dm" }),
    ])
    expect(ids).toEqual(new Set(["stream_dm"]))
  })

  it("ignores rows without a resolved stream id", () => {
    const ids = streamIdsWithLoadedDraft([unifiedDraft({ streamId: null })])
    expect(ids.size).toBe(0)
  })
})

describe("useDraftSummary", () => {
  it("counts unsent drafts and flags loaded-draft streams without building the explorer model", async () => {
    // A loaded (pointed) stream draft, a stashed stream draft, a thread draft,
    // and an empty draft that should be dropped.
    await db.drafts.bulkAdd([
      syncedDraft({ id: "draft_loaded", scope: "stream:stream_1", contentJson: makeDoc("loaded") }),
      syncedDraft({ id: "draft_stashed", scope: "stream:stream_2", contentJson: makeDoc("stashed") }),
      syncedDraft({ id: "draft_thread", scope: "thread:msg_1", contentJson: makeDoc("reply") }),
      syncedDraft({ id: "draft_empty", scope: "stream:stream_3", contentJson: EMPTY_DOC }),
    ])
    await db.composerLoaded.put({ scope: "stream:stream_1", workspaceId, draftId: "draft_loaded" })

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => ({ summary: useDraftSummary(workspaceId), all: useAllDrafts(workspaceId) }), {
      wrapper,
    })

    await waitFor(() => expect(result.current.all.drafts.length).toBe(3))

    // Empty draft dropped; loaded/stashed/thread counted; only the loaded
    // non-thread stream surfaces as a draft hint.
    expect(result.current.summary.draftCount).toBe(3)
    expect(result.current.summary.loadedDraftStreamIdSignature).toBe("stream_1")

    // Drift guard: the lightweight summary must agree with the full explorer
    // model it replaces in the sidebar.
    expect(result.current.summary.draftCount).toBe(result.current.all.drafts.length)
    const expectedSignature = [...streamIdsWithLoadedDraft(result.current.all.drafts)].sort().join(",")
    expect(result.current.summary.loadedDraftStreamIdSignature).toBe(expectedSignature)
  })
})
