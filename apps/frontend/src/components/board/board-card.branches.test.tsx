import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes } from "@threa/types"
import { BoardCard } from "./board-card"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { ServicesProvider, PanelProvider, TraceProvider, MediaGalleryProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __clearBoardRailRegistry } from "@/hooks/use-board-card-messages"
import { __clearConversationGraphRegistry } from "@/hooks/use-conversation-graph"
import { __clearBoardDraftsRegistry } from "@/hooks/use-scope-draft-preview"
import { boardBranchReplyDraftKey, boardSubtopicDraftKey } from "@/lib/board/draft-keys"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real rail + graph read paths
import { db, type CachedEvent, type CachedStream, type CachedBoardPost } from "@/db"
import * as conversationReadModule from "@/components/message/conversation-read-context"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as userProfileModule from "@/components/user-profile"
import * as syncEngineModule from "@/sync/sync-engine"
import * as contextsModule from "@/contexts"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"

const WS = "ws_1"

function cachedStream(id: string, type: string, extra: Partial<CachedStream> = {}): CachedStream {
  return {
    id,
    workspaceId: WS,
    type: type as CachedStream["type"],
    displayName: null,
    slug: null,
    description: null,
    visibility: "public",
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_me",
    createdAt: "2026-06-22T12:00:00.000Z",
    updatedAt: "2026-06-22T12:00:00.000Z",
    archivedAt: null,
    _cachedAt: 0,
    ...extra,
  }
}

interface PostOpts {
  id: string
  streamId: string
  messageIds: string[]
  opening: { id: string; streamId: string; content: string } | null
  recentMessages?: Array<{ id: string; streamId: string; content: string; authorId?: string }>
  totalReplies?: number
  streamIds: string[]
  rootStreamId: string
  topicSummary: string | null
}

function makePost(opts: PostOpts): CachedBoardPost {
  const opening = opts.opening
    ? {
        id: opts.opening.id,
        streamId: opts.opening.streamId,
        authorId: "usr_other",
        authorType: "user",
        contentMarkdown: opts.opening.content,
        reactions: {},
        attachments: [],
        linkPreviews: [],
        createdAt: "2026-06-22T12:00:00.000Z",
        editedAt: null,
      }
    : null
  return {
    id: opts.id,
    workspaceId: WS,
    _lastActivityMs: 0,
    _cachedAt: 0,
    streamIds: opts.streamIds,
    rootStreamId: opts.rootStreamId,
    rootStreamType: "channel",
    hasCapturedMemo: false,
    conversation: {
      id: opts.id,
      streamId: opts.streamId,
      workspaceId: WS,
      messageIds: opts.messageIds,
      participantIds: [],
      secondaryMessageIds: [],
      topicSummary: opts.topicSummary,
      completenessScore: 0,
      confidence: 1,
      status: "active",
      parentConversationId: null,
      lastActivityAt: "2026-06-22T12:00:00.000Z",
      createdAt: "2026-06-22T12:00:00.000Z",
      updatedAt: "2026-06-22T12:00:00.000Z",
      temporalStaleness: 0,
      effectiveCompleteness: 0,
    },
    openingMessage: opening,
    recentMessages: (opts.recentMessages ?? []).map((m) => ({
      id: m.id,
      streamId: m.streamId,
      authorId: m.authorId ?? "usr_other",
      authorType: "user",
      contentMarkdown: m.content,
      reactions: {},
      attachments: [],
      linkPreviews: [],
      createdAt: "2026-06-22T12:00:00.000Z",
      editedAt: null,
    })),
    totalReplies: opts.totalReplies ?? 0,
  } as unknown as CachedBoardPost
}

function messageEvent(id: string, streamId: string, seconds: number, content: string): CachedEvent {
  return {
    id: `evt_${id}`,
    workspaceId: WS,
    streamId,
    sequence: String(seconds),
    _sequenceNum: seconds,
    eventType: "message_created",
    payload: { messageId: id, contentMarkdown: content, reactions: {} },
    actorId: "usr_other",
    actorType: "user",
    createdAt: `2026-06-22T12:00:${String(seconds).padStart(2, "0")}.000Z`,
    _cachedAt: seconds,
  }
}

function mount(post: CachedBoardPost) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: {} as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <TraceProvider>
              <PanelProvider>
                <MediaGalleryProvider>
                  <BoardCard
                    workspaceId={WS}
                    post={post as BoardViewPost}
                    contextLabel="#general"
                    streamType="channel"
                  />
                </MediaGalleryProvider>
              </PanelProvider>
            </TraceProvider>
          </MemoryRouter>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

const readValue = { state: () => "ungated" as const, markReadUpToHere: vi.fn(), markUnread: vi.fn() }

beforeEach(async () => {
  __clearBoardRailRegistry()
  __clearConversationGraphRegistry()
  __clearBoardDraftsRegistry()
  await db.drafts.clear()
  await db.composerLoaded.clear()
  await db.events.clear()
  await db.streams.clear()
  await db.conversations.clear()
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("usr_me")
  // BoardCard hosts the inline branch composer, whose queue hook needs the
  // pending-messages provider — stub the hook so the harness stays lean.
  vi.spyOn(queueDraftModule, "useQueueDraftMessage").mockReturnValue({
    queueDraftMessage: vi.fn().mockResolvedValue({ clientId: "client_1" }),
    currentUserId: "usr_me",
  } as unknown as ReturnType<typeof queueDraftModule.useQueueDraftMessage>)
  vi.spyOn(messageReactionsModule, "useMessageReactions").mockReturnValue({
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    toggleReaction: vi.fn(),
    toggleByEmoji: vi.fn(),
  } as unknown as ReturnType<typeof messageReactionsModule.useMessageReactions>)
  vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({ openUserProfile: vi.fn() })
  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
    setBoardStreamIds: vi.fn(),
  } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(conversationReadModule, "useConversationReadController").mockReturnValue({
    value: readValue,
    hasUnread: () => false,
    markReadSilently: () => Promise.resolve(),
    setExplicitUnreadListener: () => {},
    getReadTruth: () => ({ lastReadSequence: null, readMessageIds: [] }),
  })
})

afterEach(() => vi.restoreAllMocks())

describe("BoardCard branches", () => {
  it("collapses the child conversation to one ledger row, expanding it in place", async () => {
    await db.streams.bulkPut([
      cachedStream("stream_1", StreamTypes.CHANNEL),
      cachedStream("thread_child", StreamTypes.THREAD, {
        parentStreamId: "stream_1",
        rootStreamId: "stream_1",
        parentMessageId: "m_open",
      }),
    ])
    await db.events.bulkPut([
      messageEvent("c1", "thread_child", 10, "Child branch first message."),
      messageEvent("c2", "thread_child", 11, "Child branch second message."),
    ])
    const parent = makePost({
      id: "conv_parent",
      streamId: "stream_1",
      messageIds: ["m_open"],
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["stream_1"],
      rootStreamId: "stream_1",
      topicSummary: "Hardware refresh",
    })
    const child = makePost({
      id: "conv_child",
      streamId: "thread_child",
      messageIds: ["c1", "c2"],
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["thread_child"],
      rootStreamId: "stream_1",
      topicSummary: "GPU budget",
    })
    await db.conversations.bulkPut([parent, child])

    mount(parent)
    // Default collapsed: one row naming the branch, with its outcome lead — the
    // branch's own bodies are not in the document.
    const row = await screen.findByRole("button", { name: "GPU budget, 2 messages" })
    expect(screen.queryByText("Child branch first message.")).toBeNull()
    const collapsedWrapperClass = row.closest("[data-ledger-branch-row]")!.className
    await userEvent.click(row)

    // Expanded: the child's messages render nested INSIDE the parent card (one
    // card, Reddit-style), indented under the header's left rail, and the header
    // links to the child's panel.
    const nested = await screen.findByText("Child branch first message.")
    expect(await screen.findByText("Child branch second message.")).toBeTruthy()
    expect(nested.closest(".border-l-2")).not.toBeNull()
    const header = screen.getByText("GPU budget").closest("a")
    expect(header?.getAttribute("href")).toContain("panel=conv%3Aconv_child")
    // The two states share one wrapper box, so toggling never shifts the branch's
    // leading edge (INV-21) — a stray `ml-3` on either side moves the ↳ 0.75rem.
    expect(header!.parentElement!.parentElement!.className).toBe(collapsedWrapperClass)
    // The branch tail offers the inline Reply affordance (no navigation).
    expect(screen.getByRole("button", { name: "Reply…" })).toBeTruthy()

    // Minimize returns to the collapsed row.
    await userEvent.click(screen.getByRole("button", { name: "Collapse GPU budget" }))
    expect(await screen.findByRole("button", { name: "GPU budget, 2 messages" })).toBeTruthy()
    expect(screen.queryByText("Child branch first message.")).toBeNull()
  })

  it("shows the branch's message count and its LAST message as the outcome lead", async () => {
    await db.streams.bulkPut([
      cachedStream("stream_1", StreamTypes.CHANNEL),
      cachedStream("thread_child", StreamTypes.THREAD, {
        parentStreamId: "stream_1",
        rootStreamId: "stream_1",
        parentMessageId: "m_open",
      }),
    ])
    const branchIds = ["c1", "c2", "c3", "c4", "c5", "c6"]
    await db.events.bulkPut(
      branchIds.map((id, i) =>
        messageEvent(id, "thread_child", 10 + i, i === branchIds.length - 1 ? "We went with the 5090s." : `Body ${id}.`)
      )
    )
    const parent = makePost({
      id: "conv_parent",
      streamId: "stream_1",
      messageIds: ["m_open"],
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["stream_1"],
      rootStreamId: "stream_1",
      topicSummary: "Hardware refresh",
    })
    const child = makePost({
      id: "conv_child",
      streamId: "thread_child",
      messageIds: branchIds,
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["thread_child"],
      rootStreamId: "stream_1",
      topicSummary: "GPU budget",
    })
    await db.conversations.bulkPut([parent, child])

    mount(parent)
    const row = await screen.findByRole("button", { name: "GPU budget, 6 messages" })
    expect(row.textContent).toContain("6")
    await waitFor(() => expect(row.textContent).toContain("We went with the 5090s."))
    // No branch body is in the document while collapsed.
    for (const id of branchIds) expect(screen.queryByText(`Body ${id}.`)).toBeNull()

    // Expanding keeps the overflow link into the child's panel intact.
    await userEvent.click(row)
    const overflow = await screen.findByText("4 more replies")
    expect(overflow.closest("a")?.getAttribute("href")).toContain("panel=conv%3Aconv_child")
  })

  it("carries the settling texture on a collapsed branch row", async () => {
    await db.streams.bulkPut([
      cachedStream("stream_1", StreamTypes.CHANNEL),
      cachedStream("thread_child", StreamTypes.THREAD, {
        parentStreamId: "stream_1",
        rootStreamId: "stream_1",
        parentMessageId: "m_open",
      }),
    ])
    await db.events.bulkPut([messageEvent("c1", "thread_child", 10, "Still provisional here.")])
    const parent = makePost({
      id: "conv_parent",
      streamId: "stream_1",
      messageIds: ["m_open"],
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["stream_1"],
      rootStreamId: "stream_1",
      topicSummary: "Hardware refresh",
    })
    const child = makePost({
      id: "conv_child",
      streamId: "thread_child",
      messageIds: ["c1"],
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["thread_child"],
      rootStreamId: "stream_1",
      topicSummary: "GPU budget",
    })
    // The child's provisional (still-settling) member — the branch row wears the
    // same texture the settling message rows do.
    ;(child as unknown as { settlingMessageIds: string[] }).settlingMessageIds = ["c1"]
    await db.conversations.bulkPut([parent, child])

    const { container } = mount(parent)
    // The settling state is IN the accessible name: an aria-label overrides the
    // button's content, so an sr-only span inside it would never be announced.
    const row = await screen.findByRole("button", { name: "GPU budget, 1 message, still settling" })
    expect(container.querySelector("[data-ledger-branch-row][data-settling]")).not.toBeNull()
    expect(row.contains(screen.getByText(/Still settling/))).toBe(false)
  })

  async function seedNestedBranches() {
    await db.streams.bulkPut([
      cachedStream("stream_1", StreamTypes.CHANNEL),
      cachedStream("thread_a", StreamTypes.THREAD, {
        parentStreamId: "stream_1",
        rootStreamId: "stream_1",
        parentMessageId: "m_open",
      }),
      cachedStream("thread_c", StreamTypes.THREAD, {
        parentStreamId: "thread_a",
        rootStreamId: "stream_1",
        parentMessageId: "a1",
      }),
    ])
    await db.events.bulkPut([
      messageEvent("a1", "thread_a", 10, "Branch A message."),
      messageEvent("c1", "thread_c", 11, "Grandchild C message."),
    ])
    const parent = makePost({
      id: "conv_parent",
      streamId: "stream_1",
      messageIds: ["m_open"],
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["stream_1"],
      rootStreamId: "stream_1",
      topicSummary: "Hardware refresh",
    })
    const branchA = makePost({
      id: "conv_a",
      streamId: "thread_a",
      messageIds: ["a1"],
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["thread_a"],
      rootStreamId: "stream_1",
      topicSummary: "GPU budget",
    })
    const branchC = makePost({
      id: "conv_c",
      streamId: "thread_c",
      messageIds: ["c1"],
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["thread_c"],
      rootStreamId: "stream_1",
      topicSummary: "Cooling",
    })
    return { parent, branchA, branchC }
  }

  it("rolls a grandchild branch's unsent draft up onto the collapsed ancestor row", async () => {
    const { parent, branchA, branchC } = await seedNestedBranches()
    await db.conversations.bulkPut([parent, branchA, branchC])
    await db.drafts.add({
      id: "draft_c",
      workspaceId: WS,
      scope: boardBranchReplyDraftKey("conv_c"),
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "half a reply" }] }] },
      attachments: [],
      clientUpdatedAt: 1000,
    } as never)

    const { container } = mount(parent)
    // A is collapsed, so C is not in the document at all — its draft is invisible
    // unless A's one remaining row speaks for the whole subtree.
    await screen.findByRole("button", { name: /^GPU budget, 1 message/ })
    expect(screen.queryByText("Grandchild C message.")).toBeNull()
    await waitFor(() => expect(container.querySelector("[data-branch-draft-chip]")).not.toBeNull())
    expect(screen.getByRole("button", { name: "GPU budget, 1 message, unsent draft" })).toBeInTheDocument()
  })

  it("shows the draft chip for a sub-topic draft on a branch message outside the preview window", async () => {
    await db.streams.bulkPut([
      cachedStream("stream_1", StreamTypes.CHANNEL),
      cachedStream("thread_child", StreamTypes.THREAD, {
        parentStreamId: "stream_1",
        rootStreamId: "stream_1",
        parentMessageId: "m_open",
      }),
    ])
    const branchIds = ["c1", "c2", "c3", "c4"]
    await db.events.bulkPut(branchIds.map((id, i) => messageEvent(id, "thread_child", 10 + i, `Body ${id}.`)))
    const parent = makePost({
      id: "conv_parent",
      streamId: "stream_1",
      messageIds: ["m_open"],
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["stream_1"],
      rootStreamId: "stream_1",
      topicSummary: "Hardware refresh",
    })
    const child = makePost({
      id: "conv_child",
      streamId: "thread_child",
      messageIds: branchIds,
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["thread_child"],
      rootStreamId: "stream_1",
      topicSummary: "GPU budget",
    })
    await db.conversations.bulkPut([parent, child])
    // `c1` is the OLDEST member — outside the 2-message preview window the
    // collapsed row's lead is built from.
    await db.drafts.add({
      id: "draft_old",
      workspaceId: WS,
      scope: boardSubtopicDraftKey("thread_child", "c1"),
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a sub-topic" }] }] },
      attachments: [],
      clientUpdatedAt: 1000,
    } as never)

    const { container } = mount(parent)
    await screen.findByRole("button", { name: /^GPU budget, 4 messages/ })
    await waitFor(() => expect(container.querySelector("[data-branch-draft-chip]")).not.toBeNull())
    expect(screen.getByRole("button", { name: "GPU budget, 4 messages, unsent draft" })).toBeInTheDocument()
  })

  it("rolls a grandchild branch's settling state up onto the collapsed ancestor row", async () => {
    const { parent, branchA, branchC } = await seedNestedBranches()
    ;(branchC as unknown as { settlingMessageIds: string[] }).settlingMessageIds = ["c1"]
    await db.conversations.bulkPut([parent, branchA, branchC])

    const { container } = mount(parent)
    const row = await screen.findByRole("button", { name: "GPU budget, 1 message, still settling" })
    expect(row).toBeInTheDocument()
    await waitFor(() => expect(container.querySelector("[data-ledger-branch-row][data-settling]")).not.toBeNull())
  })

  it("shows a 'branched from' provenance row on the child card", async () => {
    await db.streams.bulkPut([
      cachedStream("stream_1", StreamTypes.CHANNEL),
      cachedStream("thread_child", StreamTypes.THREAD, {
        parentStreamId: "stream_1",
        rootStreamId: "stream_1",
        parentMessageId: "m_open",
      }),
    ])
    const parent = makePost({
      id: "conv_parent",
      streamId: "stream_1",
      messageIds: ["m_open"],
      opening: { id: "m_open", streamId: "stream_1", content: "Hardware refresh opening." },
      streamIds: ["stream_1"],
      rootStreamId: "stream_1",
      topicSummary: "Hardware refresh",
    })
    const child = makePost({
      id: "conv_child",
      streamId: "thread_child",
      messageIds: ["c1"],
      opening: { id: "m_open", streamId: "stream_1", content: "Parent opening body." },
      streamIds: ["thread_child"],
      rootStreamId: "stream_1",
      topicSummary: "GPU budget",
    })
    await db.conversations.bulkPut([parent, child])

    mount(child)
    const provenance = await screen.findByText("Branched from Hardware refresh")
    expect(provenance.closest("a")?.getAttribute("href")).toContain("panel=conv%3Aconv_parent")
  })

  it("renders a soft migration with a seam and no indent", async () => {
    await db.streams.bulkPut([
      cachedStream("stream_1", StreamTypes.CHANNEL),
      cachedStream("thread_soft", StreamTypes.THREAD, {
        parentStreamId: "stream_1",
        rootStreamId: "stream_1",
        parentMessageId: "sr2",
      }),
    ])
    await db.events.bulkPut([
      messageEvent("sr1", "stream_1", 10, "First in channel."),
      messageEvent("sr2", "stream_1", 11, "Second in channel."),
      messageEvent("st1", "thread_soft", 12, "Moved into the thread."),
    ])
    const post = makePost({
      id: "conv_soft",
      streamId: "stream_1",
      messageIds: ["sr1", "sr2", "st1"],
      opening: { id: "sr1", streamId: "stream_1", content: "First in channel." },
      streamIds: ["stream_1", "thread_soft"],
      totalReplies: 2,
      rootStreamId: "stream_1",
      topicSummary: "Soft migration",
    })
    await db.conversations.bulkPut([post])

    const { container } = mount(post)
    await screen.findByText("Moved into the thread.")
    expect(await screen.findByText(/continued in/)).toBeTruthy()
    // Soft renders flat: no indent wrapper (the spanning left rail). A ledger row
    // carries its own `border-l-2` rail, so the assertion names the indent classes.
    expect(container.querySelector(".ml-3.border-l-2, .ml-6.border-l-2")).toBeNull()
  })

  it("renders a convert-to-thread continuation with no seam or split chrome", async () => {
    // A lone post whose first reply filed into a thread: the thread carries the
    // whole conversation by design, so the reply is inline — no "continued in"
    // seam, no split affordance, no indent.
    await db.streams.bulkPut([
      cachedStream("stream_1", StreamTypes.CHANNEL),
      cachedStream("thread_conv", StreamTypes.THREAD, {
        parentStreamId: "stream_1",
        rootStreamId: "stream_1",
        parentMessageId: "cr1",
      }),
    ])
    await db.events.bulkPut([
      messageEvent("cr1", "stream_1", 10, "Lone post in channel."),
      messageEvent("ct1", "thread_conv", 11, "First plain reply."),
    ])
    const post = makePost({
      id: "conv_converted",
      streamId: "stream_1",
      messageIds: ["cr1", "ct1"],
      opening: { id: "cr1", streamId: "stream_1", content: "Lone post in channel." },
      streamIds: ["stream_1", "thread_conv"],
      totalReplies: 1,
      rootStreamId: "stream_1",
      topicSummary: "Converted opener",
    })
    await db.conversations.bulkPut([post])

    const { container } = mount(post)
    await screen.findByText("First plain reply.")
    expect(screen.queryByText(/continued in/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Split into its own topic" })).toBeNull()
    expect(container.querySelector(".border-l-2")).toBeNull()
  })

  it("shows neither stub nor provenance for a thread-anchored conversation with no live source", async () => {
    await db.streams.bulkPut([
      cachedStream("stream_1", StreamTypes.CHANNEL),
      cachedStream("thread_legacy", StreamTypes.THREAD, {
        parentStreamId: "stream_1",
        rootStreamId: "stream_1",
        parentMessageId: "gone_msg",
      }),
    ])
    // No conversation contains `gone_msg`: the retired source resolves nothing.
    const post = makePost({
      id: "conv_legacy",
      streamId: "thread_legacy",
      messageIds: ["l1"],
      opening: { id: "gone_msg", streamId: "stream_1", content: "Legacy opening body." },
      streamIds: ["thread_legacy"],
      rootStreamId: "stream_1",
      topicSummary: "Legacy topic",
    })
    await db.conversations.bulkPut([post])

    mount(post)
    await screen.findByText("Legacy opening body.")
    expect(screen.queryByText(/Branched from/)).toBeNull()
    expect(screen.queryByText(/continued in/)).toBeNull()
  })
})
