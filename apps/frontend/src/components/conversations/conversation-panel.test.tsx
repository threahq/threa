import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
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
import {
  requestConversationReplyOpen,
  resetConversationReplyOpenStoreCache,
} from "@/stores/conversation-reply-open-store"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"

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
  }
}

function asCached(post: BoardPost): BoardViewPost {
  return { ...post, id: post.conversation.id, workspaceId: WORKSPACE_ID, _lastActivityMs: 0, _cachedAt: 0 }
}

function mountPanel(opts: {
  cached?: BoardViewPost | null
  getBoardPost?: () => Promise<BoardPost>
  getBoardMessages?: () => Promise<BoardPostMessage[]>
  /** `?m=` deep-link target appended to the panel URL. */
  highlightMessageId?: string
}) {
  const getBoardPost = vi.fn(opts.getBoardPost ?? (async () => makePost()))
  const getBoardMessages = vi.fn(
    opts.getBoardMessages ?? (async () => [makeMessage({ id: "msg_2", contentMarkdown: "Reply two body." })])
  )
  vi.spyOn(boardStoreModule, "useBoardPost").mockReturnValue(opts.cached as never)

  const mParam = opts.highlightMessageId ? `&m=${opts.highlightMessageId}` : ""
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: { getBoardPost, getBoardMessages } as never }}>
          <SidebarProvider>
            <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}/board?panel=conv:${CONVERSATION_ID}${mParam}`]}>
              <PanelProvider>
                <ConversationPanel workspaceId={WORKSPACE_ID} onClose={vi.fn()} />
              </PanelProvider>
            </MemoryRouter>
          </SidebarProvider>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
  return { getBoardPost, getBoardMessages }
}

beforeEach(() => {
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
  // The panel resolves its host stream type from the synced IDB row.
  vi.spyOn(streamStoreModule, "useStreamFromStore").mockReturnValue({ id: "stream_1", type: "channel" } as never)
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("usr_me")
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
  it("renders the conversation from the reactive store row without a by-id fetch", async () => {
    const { getBoardPost } = mountPanel({ cached: asCached(makePost()) })
    expect(await screen.findByText("Opening message body.")).toBeTruthy()
    expect(await screen.findByText("Reply two body.")).toBeTruthy()
    // A card already on the board never round-trips for its projection.
    expect(getBoardPost).not.toHaveBeenCalled()
  })

  it("offers a scoped reply affordance", async () => {
    mountPanel({ cached: asCached(makePost()) })
    await screen.findByText("Opening message body.")
    expect(screen.getByRole("button", { name: "Write a reply…" })).toBeTruthy()
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
