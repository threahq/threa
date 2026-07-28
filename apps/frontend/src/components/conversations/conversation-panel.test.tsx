import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useNavigate } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardPost, BoardPostMessage, ConversationWithStaleness } from "@threa/types"
import { ConversationPanel } from "./conversation-panel"
import { ServicesProvider, SidebarProvider, PanelProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { spyOnExport } from "@/test/spy"
import * as editorModule from "@/components/editor"
import * as messageEditFormModule from "@/components/timeline/message-edit-form"
import * as messageHistoryDialogModule from "@/components/timeline/message-history-dialog"
import * as boardStoreModule from "@/stores/board-store"
import * as streamStoreModule from "@/stores/stream-store"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as syncEngineModule from "@/sync/sync-engine"
import * as userProfileModule from "@/components/user-profile"
import * as contextsModule from "@/contexts"
import * as touchCapableModule from "@/hooks/use-touch-capable"
import * as discussModule from "@/hooks/use-discuss-with-ariadne"
import * as shareHandoffModule from "@/stores/share-handoff-store"
import * as boardReplyComposerModule from "@/components/board/board-reply-composer"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"
import * as stashedDraftsModule from "@/hooks/use-stashed-drafts"
import { boardReplyDraftKey } from "@/lib/board/draft-keys"
import {
  FLOATING_COMPOSER_HEIGHT_VAR,
  useFloatingComposerAnchor,
  useFloatingComposerHeight,
} from "@/components/composer"
import {
  requestConversationReplyOpen,
  resetConversationReplyOpenStoreCache,
} from "@/stores/conversation-reply-open-store"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { formatDayDivider, localStartOfDayMs } from "@/lib/dates"

const WORKSPACE_ID = "ws_1"
const CONVERSATION_ID = "conv_1"

function makeMessage(overrides: Partial<BoardPostMessage> = {}): BoardPostMessage {
  return {
    id: "msg_1",
    streamId: "stream_1",
    authorId: "usr_me",
    authorType: "user",
    contentMarkdown: "Opening message body.",
    reactions: {},
    attachments: [],
    linkPreviews: [],
    createdAt: "2026-06-22T12:00:00.000Z",
    editedAt: null,
    ...overrides,
  }
}

function makeConversation(): ConversationWithStaleness {
  const now = "2026-06-22T12:00:00.000Z"
  return {
    id: CONVERSATION_ID,
    streamId: "stream_1",
    workspaceId: WORKSPACE_ID,
    messageIds: ["msg_1", "msg_2"],
    participantIds: ["usr_me"],
    secondaryMessageIds: [],
    topicSummary: "CC Teams tokens",
    summary: null,
    completenessScore: 4,
    confidence: 0.8,
    status: "active",
    parentConversationId: null,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    temporalStaleness: 0,
    effectiveCompleteness: 4,
  }
}

function makePost(): BoardPost {
  const conversation = makeConversation()
  return {
    conversation,
    openingMessage: makeMessage({ id: "msg_1" }),
    recentMessages: [makeMessage({ id: "msg_2", contentMarkdown: "Reply two body." })],
    totalReplies: 1,
    streamIds: ["stream_1"],
    hasCapturedMemo: false,
    isMine: false,
  }
}

function asCached(post: BoardPost): BoardViewPost {
  return { ...post, id: post.conversation.id, workspaceId: WORKSPACE_ID, _lastActivityMs: 0, _cachedAt: 0 }
}

/**
 * jsdom has no layout: give every element a scrollable box and a real scrollTop
 * so the panel's scroll wiring (which reads/writes exactly those three) is
 * observable. Restored per test.
 */
function installScrollMetrics({ scrollHeight = 1000, clientHeight = 300 } = {}) {
  const tops = new WeakMap<HTMLElement, number>()
  const descriptors = {
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop"),
  }
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => clientHeight })
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      tops.set(this, value)
    },
  })
  return () => {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
  }
}

function scroller(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".overflow-y-auto")
  if (!el) throw new Error("panel scroller not found")
  return el
}

function mountPanel(opts: {
  cached?: BoardViewPost | null
  /** Per-conversation store rows, for a switch between two open conversations. */
  cachedById?: Record<string, BoardViewPost>
  getBoardPost?: () => Promise<BoardPost>
  getBoardMessages?: () => Promise<BoardPostMessage[]>
  /** `?m=` deep-link target appended to the panel URL. */
  highlightMessageId?: string
  /** `?stash=` drafts-explorer restore param appended to the panel URL. */
  stashParam?: string
  /** Conversation the panel opens on (defaults to the shared fixture id). */
  conversationId?: string
}) {
  const getBoardPost = vi.fn(opts.getBoardPost ?? (async () => makePost()))
  const getBoardMessages = vi.fn(
    opts.getBoardMessages ?? (async () => [makeMessage({ id: "msg_2", contentMarkdown: "Reply two body." })])
  )
  if (opts.cachedById) {
    const byId = opts.cachedById
    vi.spyOn(boardStoreModule, "useBoardPost").mockImplementation(((id: string | null) =>
      id ? (byId[id] ?? null) : null) as never)
  } else {
    vi.spyOn(boardStoreModule, "useBoardPost").mockReturnValue(opts.cached as never)
  }

  const mParam =
    (opts.highlightMessageId ? `&m=${opts.highlightMessageId}` : "") +
    (opts.stashParam ? `&stash=${opts.stashParam}` : "")
  const startId = opts.conversationId ?? CONVERSATION_ID
  // Captures the router's navigate so a test can switch the panel to another
  // conversation in place (initialEntries only apply at mount).
  const nav: { openConversation: (id: string) => void } = { openConversation: () => {} }
  function Navigator() {
    const navigate = useNavigate()
    nav.openConversation = (id) => navigate(`/w/${WORKSPACE_ID}/board?panel=conv:${id}`)
    return null
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: { getBoardPost, getBoardMessages } as never }}>
          <SidebarProvider>
            <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}/board?panel=conv:${startId}${mParam}`]}>
              <PanelProvider>
                <Navigator />
                <ConversationPanel workspaceId={WORKSPACE_ID} onClose={vi.fn()} />
              </PanelProvider>
            </MemoryRouter>
          </SidebarProvider>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
  return { getBoardPost, getBoardMessages, nav }
}

beforeEach(() => {
  // Default composer stub: the real form (desktop always-open since the
  // thread-semantics ruling) pulls auth/mention providers this harness doesn't
  // mount. Tests that inspect composer props install their own spy.
  vi.spyOn(boardReplyComposerModule, "BoardReplyComposer").mockImplementation(() => (
    <button type="button">Write a reply…</button>
  ))
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
  // The panel resolves its host stream type from the synced IDB row.
  vi.spyOn(streamStoreModule, "useStreamFromStore").mockReturnValue({ id: "stream_1", type: "channel" } as never)
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
  // The panel declares its conversation's streams to the SyncEngine (own slot).
  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
    setBoardStreamIds: vi.fn(),
    setPanelStreamIds: vi.fn(),
  } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)
  vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({ openUserProfile: vi.fn() })
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
})

afterEach(() => {
  resetConversationReplyOpenStoreCache()
  vi.restoreAllMocks()
})

describe("ConversationPanel", () => {
  let restoreRect: (() => void) | null = null
  afterEach(() => {
    restoreRect?.()
    restoreRect = null
  })

  it("renders the conversation from the reactive store row without a by-id fetch", async () => {
    const { getBoardPost } = mountPanel({ cached: asCached(makePost()) })
    expect(await screen.findByText("Opening message body.")).toBeTruthy()
    expect(await screen.findByText("Reply two body.")).toBeTruthy()
    // A card already on the board never round-trips for its projection.
    expect(getBoardPost).not.toHaveBeenCalled()
  })

  it("shows a day divider between messages from different days", async () => {
    // Local-clock times straddling midnight, so the bucket is the device day (INV-42).
    const lateNight = new Date(2026, 5, 21, 23, 0, 0)
    const afterMidnight = new Date(2026, 5, 22, 0, 30, 0)
    const post = makePost()
    const cached = asCached({
      ...post,
      openingMessage: makeMessage({ id: "msg_1", createdAt: lateNight.toISOString() }),
      recentMessages: [
        makeMessage({ id: "msg_2", contentMarkdown: "Reply two body.", createdAt: afterMidnight.toISOString() }),
      ],
    })
    mountPanel({ cached })
    await screen.findByText("Opening message body.")
    expect(screen.getByText(formatDayDivider(new Date(localStartOfDayMs(afterMidnight))))).toBeTruthy()
    // Never above the first row.
    expect(screen.queryByText(formatDayDivider(new Date(localStartOfDayMs(lateNight))))).toBeNull()
  })

  it("docks the scoped reply composer (alwaysDocked — no resting button)", async () => {
    let captured: boolean | undefined
    vi.spyOn(boardReplyComposerModule, "BoardReplyComposer").mockImplementation((props) => {
      captured = props.alwaysDocked
      return <div data-testid="docked-composer" />
    })
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")
    expect(screen.getByTestId("docked-composer")).toBeTruthy()
    expect(captured).toBe(true)
  })

  it("bumps openReplySignal on the composer when opened via 'Reply in conversation' (queued request)", async () => {
    // The message-row action queues this before opening the panel; the panel picks
    // it up on mount and bumps its composer's open signal instead of resting collapsed.
    let captured: number | undefined
    vi.spyOn(boardReplyComposerModule, "BoardReplyComposer").mockImplementation((props) => {
      captured = props.openReplySignal
      return <></>
    })
    requestConversationReplyOpen(CONVERSATION_ID)
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")
    await waitFor(() => expect(captured ?? 0).toBeGreaterThan(0))
  })

  it("leaves the composer collapsed on a plain open (no queued request)", async () => {
    let captured: number | undefined
    vi.spyOn(boardReplyComposerModule, "BoardReplyComposer").mockImplementation((props) => {
      captured = props.openReplySignal
      return <></>
    })
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")
    expect(captured).toBe(0)
  })

  it("opens the reply composer for a ?stash= deep link whose row belongs to its reply scope", async () => {
    // The drafts explorer deep-links a stashed board reply to the panel; the
    // collapsed resting affordance mounts no composer, so the panel itself must
    // open the form for the stash restore to have a consumer.
    vi.spyOn(stashedDraftsModule, "useStashedDrafts").mockImplementation(
      (_ws, scope) =>
        ({
          drafts: scope === boardReplyDraftKey(CONVERSATION_ID) ? [{ id: "draft_owned" }] : [],
          isLoaded: true,
          deleteStashedDraft: vi.fn(),
        }) as unknown as ReturnType<typeof stashedDraftsModule.useStashedDrafts>
    )
    let captured: number | undefined
    vi.spyOn(boardReplyComposerModule, "BoardReplyComposer").mockImplementation((props) => {
      captured = props.openReplySignal
      return <></>
    })
    mountPanel({ cached: asCached(makePost()), stashParam: "draft_owned" })
    await screen.findByText("Opening message body.")
    await waitFor(() => expect(captured).toBe(1))
  })

  it("ignores a ?stash= param whose row is not in its reply scope's pile", async () => {
    // A foreign scope's stash id (e.g. a thread draft on the same route) must be
    // left for its own host — opening here would strand the restore.
    vi.spyOn(stashedDraftsModule, "useStashedDrafts").mockReturnValue({
      drafts: [],
      isLoaded: true,
      deleteStashedDraft: vi.fn(),
    } as unknown as ReturnType<typeof stashedDraftsModule.useStashedDrafts>)
    let captured: number | undefined
    vi.spyOn(boardReplyComposerModule, "BoardReplyComposer").mockImplementation((props) => {
      captured = props.openReplySignal
      return <></>
    })
    mountPanel({ cached: asCached(makePost()), stashParam: "draft_foreign" })
    await screen.findByText("Opening message body.")
    expect(captured).toBe(0)
  })

  it("re-bumps openReplySignal on a repeat request while the panel is already open", async () => {
    // A boolean handoff would no-op here (already true); the nonce increments so
    // the composer reopens after a manual collapse on a second "Reply in conversation".
    let captured: number | undefined
    vi.spyOn(boardReplyComposerModule, "BoardReplyComposer").mockImplementation((props) => {
      captured = props.openReplySignal
      return <></>
    })
    requestConversationReplyOpen(CONVERSATION_ID)
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")
    await waitFor(() => expect(captured).toBe(1))

    act(() => requestConversationReplyOpen(CONVERSATION_ID))
    await waitFor(() => expect(captured).toBe(2))
  })

  it("fetches the post by id when the store has no row (deep-link / in-stream list)", async () => {
    const { getBoardPost } = mountPanel({ cached: null })
    expect(await screen.findByText("Opening message body.")).toBeTruthy()
    await waitFor(() => expect(getBoardPost).toHaveBeenCalledWith(WORKSPACE_ID, CONVERSATION_ID))
  })

  it("flashes the ?m= deep-link target row and leaves the others unhighlighted", async () => {
    mountPanel({ cached: asCached(makePost()), highlightMessageId: "msg_2" })
    const replyBody = await screen.findByText("Reply two body.")
    expect(replyBody.closest(".animate-highlight-flash")).toBeTruthy()

    const openingBody = screen.getByText("Opening message body.")
    expect(openingBody.closest(".animate-highlight-flash")).toBeNull()
  })

  it("surfaces a Quote reply action on message rows (the conversation composer is in the tree)", async () => {
    const user = userEvent.setup()
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")

    const [firstRowMenu] = screen.getAllByRole("button", { name: "Message actions" })
    await user.click(firstRowMenu)

    expect(await screen.findByText("Quote reply")).toBeTruthy()
  })

  it("shares a conversation row with a conversation-aware pointer (conversationId in the handoff)", async () => {
    const user = userEvent.setup()
    // Give the share picker one selectable target channel.
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([
      { id: "stream_target", type: "channel", slug: "general", displayName: null, visibility: "public" },
    ] as never)
    const queueSpy = vi.spyOn(shareHandoffModule, "queueShareHandoff").mockImplementation(() => {})

    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")

    const [firstRowMenu] = screen.getAllByRole("button", { name: "Message actions" })
    await user.click(firstRowMenu)
    await user.click(await screen.findByText("Share message"))

    // The cross-stream picker opens; selecting a target queues the share.
    await user.click(await screen.findByText("#general"))

    expect(queueSpy).toHaveBeenCalledWith(
      "stream_target",
      expect.objectContaining({ messageId: "msg_1", conversationId: CONVERSATION_ID })
    )
  })

  it("reveals the quote affordance when a row is swiped left on touch", async () => {
    vi.spyOn(touchCapableModule, "useTouchCapable").mockReturnValue(true)
    mountPanel({ cached: asCached(makePost()) })
    const replyBody = await screen.findByText("Reply two body.")
    const row = replyBody.closest("[class*='overflow-hidden']") as HTMLElement

    fireEvent.touchStart(row, { touches: [{ clientX: 200, clientY: 100 }] })
    fireEvent.touchMove(row, { touches: [{ clientX: 90, clientY: 100 }] })

    // Past the horizontal threshold → the swipe-to-quote reveal icon renders.
    expect(document.querySelector(".lucide-quote")).toBeTruthy()
  })

  it("offers a conversation-level copy-link affordance in the header", async () => {
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")
    expect(screen.getByRole("button", { name: "Copy link to conversation" })).toBeTruthy()
  })

  it("shows a not-found state when the conversation is gone/unreadable", async () => {
    mountPanel({
      cached: null,
      getBoardPost: async () => {
        throw new Error("404")
      },
    })
    expect(await screen.findByText("Couldn't open this conversation")).toBeTruthy()
  })

  it("lets the author edit their own row in place, swapping the body for the editor", async () => {
    // The shared row hosts the timeline's MessageEditForm; stub the real
    // tiptap editor to a textarea (name = ariaLabel) so we assert the wiring,
    // not the editor internals.
    spyOnExport(editorModule, "RichEditor").mockReturnValue((({
      ariaLabel,
      placeholder,
    }: {
      ariaLabel: string
      placeholder?: string
    }) => <textarea aria-label={ariaLabel} placeholder={placeholder} />) as unknown as typeof editorModule.RichEditor)
    vi.spyOn(editorModule, "DocumentEditorModal").mockImplementation(
      (() => null) as unknown as typeof editorModule.DocumentEditorModal
    )
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)

    const user = userEvent.setup()
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")

    const [firstRowMenu] = screen.getAllByRole("button", { name: "Message actions" })
    await user.click(firstRowMenu)
    await user.click(await screen.findByText("Edit message"))

    // The inline editor takes over the row; the rendered body is gone.
    expect(screen.getByRole("textbox", { name: "Edit message" })).toBeTruthy()
    expect(screen.queryByText("Opening message body.")).toBeNull()
  })

  it("hides Edit on a row authored by someone else", async () => {
    const user = userEvent.setup()
    const post = makePost()
    post.openingMessage = makeMessage({ id: "msg_1", authorId: "usr_other" })
    mountPanel({ cached: asCached(post) })
    await screen.findByText("Opening message body.")

    const [firstRowMenu] = screen.getAllByRole("button", { name: "Message actions" })
    await user.click(firstRowMenu)

    await screen.findByRole("menu")
    expect(screen.queryByText("Edit message")).toBeNull()
    expect(screen.queryByText("Delete message")).toBeNull()
  })

  it("offers a standalone Delete message action that confirms then deletes the row", async () => {
    const deleteMessage = vi.fn().mockResolvedValue({})
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      delete: deleteMessage,
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)

    const user = userEvent.setup()
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")

    const [firstRowMenu] = screen.getAllByRole("button", { name: "Message actions" })
    await user.click(firstRowMenu)
    await user.click(await screen.findByText("Delete message"))

    // The owner-only action opens the same confirm dialog as clear-to-empty.
    await user.click(await screen.findByRole("button", { name: "Delete" }))
    await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith(WORKSPACE_ID, "msg_1"))
  })

  it("clearing an edit to empty confirms then deletes the message", async () => {
    // Stub the edit form to a button that fires its onDelete (the empty-submit
    // path), so this test exercises MessageItem's clear-to-delete wiring —
    // confirm dialog → messageService.delete — not the editor internals.
    spyOnExport(messageEditFormModule, "MessageEditForm").mockReturnValue((({
      onDelete,
    }: {
      onDelete?: () => void
    }) => (
      <button type="button" onClick={onDelete}>
        stub-clear-to-delete
      </button>
    )) as unknown as typeof messageEditFormModule.MessageEditForm)
    const deleteMessage = vi.fn().mockResolvedValue({})
    vi.spyOn(contextsModule, "useMessageService").mockReturnValue({
      delete: deleteMessage,
    } as unknown as ReturnType<typeof contextsModule.useMessageService>)

    const user = userEvent.setup()
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")

    const [firstRowMenu] = screen.getAllByRole("button", { name: "Message actions" })
    await user.click(firstRowMenu)
    await user.click(await screen.findByText("Edit message"))
    await user.click(await screen.findByText("stub-clear-to-delete"))

    // Confirm dialog, then delete routes to the message service.
    await user.click(await screen.findByRole("button", { name: "Delete" }))
    await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith(WORKSPACE_ID, "msg_1"))
  })

  it("offers Discuss with Ariadne seeded with the whole conversation's span, not one stream", async () => {
    // The conversation surface must start the discussion with a conversation-
    // scoped target (root + its threads), never a single-stream thread ref —
    // that's the whole point of #2. The hook itself is unit-tested; here we pin
    // the wiring: the row passes the conversation id + its root + the focal.
    const startDiscuss = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(discussModule, "useDiscussWithAriadne").mockReturnValue(startDiscuss)

    const user = userEvent.setup()
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")

    const [firstRowMenu] = screen.getAllByRole("button", { name: "Message actions" })
    await user.click(firstRowMenu)
    await user.click(await screen.findByText("Discuss with Ariadne"))

    expect(startDiscuss).toHaveBeenCalledWith({
      kind: "conversation",
      conversationId: CONVERSATION_ID,
      rootStreamId: "stream_1",
      sourceMessageId: "msg_1",
    })
  })

  it("opens at the tail of the conversation", async () => {
    const restore = installScrollMetrics()
    try {
      mountPanel({ cached: asCached(makePost()) })
      await screen.findByText("Reply two body.")
      await waitFor(() => expect(scroller().scrollTop).toBe(1000))
    } finally {
      restore()
    }
  })

  it("re-anchors to the tail when the panel switches to another conversation", async () => {
    const restore = installScrollMetrics()
    try {
      const second = makePost()
      second.conversation = { ...second.conversation, id: "conv_2" }
      second.openingMessage = makeMessage({ id: "msg_9", contentMarkdown: "Second conversation opener." })
      second.recentMessages = []
      second.totalReplies = 0
      const { nav } = mountPanel({
        cachedById: { [CONVERSATION_ID]: asCached(makePost()), conv_2: asCached(second) },
      })
      await screen.findByText("Reply two body.")

      // Park the user mid-list, then switch conversations: without resetKey the
      // new conversation would inherit this scroll state and open mid-list.
      // The wait outlasts the hook's 150ms post-programmatic-scroll grace, in
      // which a scroll event does not clear the follow flag.
      const el = scroller()
      await new Promise((r) => setTimeout(r, 200))
      el.scrollTop = 0
      act(() => fireEvent.scroll(el))

      act(() => nav.openConversation("conv_2"))
      await screen.findByText("Second conversation opener.")
      await waitFor(() => expect(scroller().scrollTop).toBe(1000))
    } finally {
      restore()
    }
  })

  it("keeps the deep-linked row when the backfill lands", async () => {
    const restore = installScrollMetrics()
    try {
      const post = makePost()
      // Rail is short of the server's count → the panel backfills, growing the
      // row list after first paint.
      post.totalReplies = 3
      mountPanel({
        cached: asCached(post),
        highlightMessageId: "msg_2",
        getBoardMessages: async () => [
          makeMessage({ id: "msg_2", contentMarkdown: "Reply two body." }),
          makeMessage({ id: "msg_3", contentMarkdown: "Backfilled reply three." }),
          makeMessage({ id: "msg_4", contentMarkdown: "Backfilled reply four." }),
        ],
      })
      await screen.findByText("Backfilled reply four.")

      expect(scroller().scrollTop).toBe(0)
    } finally {
      restore()
    }
  })

  it("renders the reply composer in the shared floating shell, not a bordered footer", async () => {
    vi.spyOn(boardReplyComposerModule, "BoardReplyComposer").mockImplementation(() => (
      <div data-testid="docked-composer" />
    ))
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")

    const composer = screen.getByTestId("docked-composer")
    expect(composer.closest(".absolute.inset-x-0.bottom-0")).toBeTruthy()
    expect(composer.closest(".border-t")).toBeNull()
  })

  it("hides the root pill and keeps a non-zero bottom reservation while a branch composer holds the anchor", async () => {
    // The stub stands in for a branch composer that claims the floating slot and
    // publishes its own height through the shared hook — the hand-off R2 is about.
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = () => ({ height: 64 }) as DOMRect
    restoreRect = () => {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
    function BranchClaimant() {
      const anchor = useFloatingComposerAnchor()
      const anchorEl = anchor?.el ?? null
      const claim = anchor?.claim
      useEffect(() => {
        claim?.("branch")
      }, [claim])
      const shellRef = useFloatingComposerHeight({
        anchorEl,
        ownerId: "branch",
        active: anchor?.claimantId === "branch",
      })
      return <div ref={shellRef} data-testid="branch-pill" />
    }
    vi.spyOn(boardReplyComposerModule, "BoardReplyComposer").mockImplementation(() => <BranchClaimant />)

    mountPanel({ cached: asCached(makePost()) })
    const pill = await screen.findByTestId("branch-pill")

    await waitFor(() => {
      const anchorEl = document.querySelector<HTMLElement>("[data-floating-composer-owner]")
      expect(anchorEl?.style.getPropertyValue(FLOATING_COMPOSER_HEIGHT_VAR)).toBe("64px")
    })
    // The root pill is display:none while the branch owns the slot.
    expect(pill.closest("div.hidden")).toBeTruthy()
  })

  it("shows Jump to latest only when scrolled far from the bottom, and returns to the tail on click", async () => {
    const restore = installScrollMetrics()
    try {
      const user = userEvent.setup()
      // Enough rows that 10 rows' worth of scroll is inside the 1000px box —
      // the button's threshold is item-count relative.
      const post = makePost()
      post.recentMessages = Array.from({ length: 40 }, (_, i) =>
        makeMessage({ id: `msg_${i + 2}`, contentMarkdown: `Reply ${i + 2} body.` })
      )
      post.conversation = { ...post.conversation, messageIds: ["msg_1", ...post.recentMessages.map((m) => m.id)] }
      post.totalReplies = post.recentMessages.length
      mountPanel({ cached: asCached(post), getBoardMessages: async () => post.recentMessages })
      await screen.findByText(`Reply ${post.recentMessages.length + 1} body.`)
      expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull()

      // The browser emits a scroll event once the opening bottom-pin settles;
      // jsdom does not, and that event is what releases the force-scroll guard.
      const el = scroller()
      act(() => fireEvent.scroll(el))
      el.scrollTop = 0
      act(() => fireEvent.scroll(el))

      const jump = await screen.findByRole("button", { name: "Jump to latest" })
      await user.click(jump)

      expect(el.scrollTop).toBe(1000)
      await waitFor(() => expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull())
    } finally {
      restore()
    }
  })

  it("shows an (edited) indicator and a See revisions action on an edited row", async () => {
    // Stub the versions dialog to a marker so we assert the open wiring, not the
    // version fetch.
    spyOnExport(messageHistoryDialogModule, "MessageHistoryDialog").mockReturnValue((({ open }: { open: boolean }) =>
      open ? <div>stub-history</div> : null) as unknown as typeof messageHistoryDialogModule.MessageHistoryDialog)

    const user = userEvent.setup()
    const post = makePost()
    post.openingMessage = makeMessage({ id: "msg_1", editedAt: "2026-06-22T13:00:00.000Z" })
    mountPanel({ cached: asCached(post) })
    await screen.findByText("Opening message body.")

    // Inline "(edited)" affordance on the row.
    const edited = await screen.findByText("(edited)")

    // "See revisions" is offered in the row's action menu.
    const [firstRowMenu] = screen.getAllByRole("button", { name: "Message actions" })
    await user.click(firstRowMenu)
    expect(await screen.findByText("See revisions")).toBeTruthy()
    await user.keyboard("{Escape}") // close the menu's modal overlay before clicking the row

    // Clicking the indicator opens the revisions dialog.
    await user.click(edited)
    expect(await screen.findByText("stub-history")).toBeTruthy()
  })
})
