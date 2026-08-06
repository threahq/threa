import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ReactNode } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useSearchParams } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as useAttachmentsModule from "@/hooks/use-attachments"
import * as currentUserHook from "@/hooks/use-current-workspace-user-id"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as authModule from "@/auth"
import * as e2eSessionStore from "@/stores/e2e-session-store"
import * as conversationReplyModule from "./conversation-reply-context"
import * as useConversationsModule from "@/hooks/use-conversations"
import * as composerModule from "@/components/composer"
import * as discussModule from "@/hooks/use-discuss-with-ariadne"
import * as streamContextBagModule from "@/hooks/use-stream-context-bag"
import * as streamCommandsModule from "@/hooks/use-stream-commands"
import { spyOnExport } from "@/test"
import { upsertLoadedDraft, stashLoadedDraft } from "@/hooks/use-draft-message"
import { resetDraftStoreCache, seedDraftCacheFromIdb } from "@/stores/draft-store"
import { resetDraftResolutionGuard } from "@/sync/draft-resolution-guard"
import { resetApplyWindow } from "@/stores/apply-window"
import { setComposerTarget } from "@/hooks/use-composer-target"
// eslint-disable-next-line no-restricted-imports -- seeds/asserts the real draft + composer-target rows
import { db } from "@/db"
import { MessageInput } from "./message-input"
import type { JSONContent } from "@threa/types"

// The real draft composer runs here (only `useAttachments` is stubbed), so this
// file covers what a mocked composer cannot: which draft row the editor renders
// and which draft row a keystroke lands in.
const workspaceId = "ws_target"
const streamId = "stream_host"
const hostScope = "stream:stream_host"
const boardScope = "board:reply:conv_1"

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})
const docText = (content: JSONContent): string => JSON.stringify(content).match(/"text":"([^"]*)"/)?.[1] ?? ""

const LOCKED_SESSION = {
  status: "locked",
  keyId: null,
  publicKey: null,
  privateKey: null,
  deviceTrusted: false,
  error: null,
} as ReturnType<typeof e2eSessionStore.useE2eSession>

let registeredConversationReplyHandler: ((data: { conversationId: string }) => void) | null = null
let notFound = false
let loadFailed = false
let lastActiveStreamId = streamId
let e2eEnabled = false
let openPanelSpy = vi.fn()

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

beforeEach(async () => {
  vi.restoreAllMocks()
  resetApplyWindow()
  resetDraftStoreCache()
  resetDraftResolutionGuard()
  localStorage.clear()
  await db.drafts.clear()
  await db.composerLoaded.clear()
  await db.composerTarget.clear()
  await db.pendingOperations.clear()
  registeredConversationReplyHandler = null
  notFound = false
  loadFailed = false
  lastActiveStreamId = streamId
  e2eEnabled = false
  openPanelSpy = vi.fn()

  vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue(null)
  vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(LOCKED_SESSION)
  vi.spyOn(useAttachmentsModule, "useAttachments").mockReturnValue({
    pendingAttachments: [],
    getPendingAttachmentsSnapshot: () => [],
    fileInputRef: { current: null },
    handleFileSelect: vi.fn(),
    uploadFile: vi.fn(),
    removeAttachment: vi.fn(),
    cancelUpload: vi.fn(),
    uploadedIds: [],
    isUploading: false,
    isReserving: false,
    hasFailed: false,
    clear: vi.fn(),
    restore: vi.fn(),
    imageCount: 0,
  } as unknown as ReturnType<typeof useAttachmentsModule.useAttachments>)

  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { messageSendMode: "enter" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(contextsModule, "useSocketStatus").mockReturnValue(
    "connected" as ReturnType<typeof contextsModule.useSocketStatus>
  )
  vi.spyOn(contextsModule, "usePanel").mockReturnValue({
    openPanel: openPanelSpy,
  } as unknown as ReturnType<typeof contextsModule.usePanel>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(
    [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue(
    [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
  )
  vi.spyOn(authModule, "useUser").mockReturnValue(null as unknown as ReturnType<typeof authModule.useUser>)
  vi.spyOn(hooksModule, "useStreamBootstrap").mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof hooksModule.useStreamBootstrap>)
  spyOnExport(streamCommandsModule, "useStreamCommands").mockReturnValue((() => []) as never)
  vi.spyOn(hooksModule, "useMentionStreamContext").mockReturnValue(
    undefined as unknown as ReturnType<typeof hooksModule.useMentionStreamContext>
  )
  vi.spyOn(hooksModule, "useStreamOrDraft").mockImplementation(
    () =>
      ({
        stream: { id: streamId, e2eEnabled, rootStreamId: streamId },
        sendMessage: vi.fn().mockResolvedValue({}),
      }) as unknown as ReturnType<typeof hooksModule.useStreamOrDraft>
  )
  vi.spyOn(hooksModule, "useScheduleMessage").mockReturnValue({
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof hooksModule.useScheduleMessage>)
  vi.spyOn(hooksModule, "useComposerHeightPublish").mockImplementation(
    () => undefined as unknown as ReturnType<typeof hooksModule.useComposerHeightPublish>
  )
  vi.spyOn(hooksModule, "useDecryptedDraftPreviews").mockReturnValue(new Map())
  vi.spyOn(discussModule, "useDiscussWithAriadne").mockImplementation(
    () => vi.fn() as unknown as ReturnType<typeof discussModule.useDiscussWithAriadne>
  )
  vi.spyOn(streamContextBagModule, "useStreamContextBag").mockReturnValue({
    data: { bag: null, refs: [] },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof streamContextBagModule.useStreamContextBag>)
  vi.spyOn(conversationReplyModule, "useConversationReply").mockReturnValue({
    triggerReplyInConversation: vi.fn(),
    registerHandler: (handler: (data: { conversationId: string }) => void) => {
      registeredConversationReplyHandler = handler
      return () => {
        registeredConversationReplyHandler = null
      }
    },
  } as unknown as ReturnType<typeof conversationReplyModule.useConversationReply>)
  vi.spyOn(useConversationsModule, "useConversationBoardPost").mockImplementation(
    (_workspaceId: string, conversationId: string | null) =>
      ({
        post:
          conversationId && !notFound && !loadFailed
            ? {
                conversation: { id: conversationId, streamId, topicSummary: "Pizza plans" },
                recentMessages: [{ streamId: lastActiveStreamId }],
              }
            : null,
        isLoading: false,
        notFound: !!conversationId && notFound,
        loadFailed: !!conversationId && loadFailed,
        refetch: vi.fn(),
      }) as unknown as ReturnType<typeof useConversationsModule.useConversationBoardPost>
  )
  vi.spyOn(composerModule, "ScheduledMessagesPicker").mockImplementation(
    (() => null) as unknown as typeof composerModule.ScheduledMessagesPicker
  )
  vi.spyOn(composerModule, "FloatingComposerShell").mockImplementation((({
    children,
    hidden,
  }: {
    children: ReactNode
    hidden?: boolean
  }) => (hidden ? null : <div>{children}</div>)) as unknown as typeof composerModule.FloatingComposerShell)
  // Renders the composer's live content and offers a keystroke, so a test can
  // read which draft is on screen and write into whichever draft is open.
  vi.spyOn(composerModule, "MessageComposer").mockImplementation((({
    content,
    onContentChange,
  }: {
    content: JSONContent
    onContentChange: (value: JSONContent) => void
  }) => (
    <div>
      <span data-testid="editor-body">{docText(content)}</span>
      <button onClick={() => onContentChange(makeDoc("typed here"))}>type</button>
    </div>
  )) as unknown as typeof composerModule.MessageComposer)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mount(initialEntries: string[] = ["/"], mountStreamId: string = streamId) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <MessageInput workspaceId={workspaceId} streamId={mountStreamId} />
        <SearchParamsProbe />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** The same tree with a different stream — `MessageInput` is NOT remounted per
 *  stream in the app (same route, param-only change), so a navigation is a
 *  rerender and any ref that outlives it is shared across streams. */
function rerenderAtStream(view: ReturnType<typeof mount>, nextStreamId: string) {
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <MessageInput workspaceId={workspaceId} streamId={nextStreamId} />
        <SearchParamsProbe />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

async function seedDrafts() {
  await upsertLoadedDraft(workspaceId, hostScope, { contentJson: makeDoc("stream body"), attachments: [] })
  await upsertLoadedDraft(workspaceId, boardScope, { contentJson: makeDoc("board body"), attachments: [] })
  await act(async () => {
    await seedDraftCacheFromIdb(workspaceId)
  })
}

/** Let pending liveQuery emissions, effects and microtasks land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

function SearchParamsProbe() {
  const [params] = useSearchParams()
  return <span data-testid="search-params">{params.toString()}</span>
}

async function bodyOf(scope: string): Promise<string> {
  const rows = await db.drafts.where("scope").equals(scope).toArray()
  return rows.map((row) => docText(row.contentJson)).join("|")
}

describe("the timeline composer's durable target", () => {
  it("edits the targeted board draft, not the stream's own — and a keystroke lands there", async () => {
    await seedDrafts()
    await setComposerTarget(workspaceId, hostScope, boardScope)

    mount()

    await waitFor(() => expect(screen.getByTestId("editor-body")).toHaveTextContent("board body"))

    await userEvent.click(screen.getByRole("button", { name: "type" }))
    await waitFor(async () => expect(await bodyOf(boardScope)).toBe("typed here"))
    expect(await bodyOf(hostScope)).toBe("stream body")
  })

  it("survives a reload — a fresh mount reads the stored target", async () => {
    await seedDrafts()
    await setComposerTarget(workspaceId, hostScope, boardScope)

    const first = mount()
    await waitFor(() => expect(screen.getByTestId("editor-body")).toHaveTextContent("board body"))
    first.unmount()

    // Same durable state, brand new component tree — the arm is not session state.
    resetDraftStoreCache()
    await act(async () => {
      await seedDraftCacheFromIdb(workspaceId)
    })
    mount()
    await waitFor(() => expect(screen.getByTestId("editor-body")).toHaveTextContent("board body"))
    expect(screen.getByTestId("conversation-reply-strip")).toHaveTextContent("Replying in Pizza plans")
  })

  it("arms from the gesture and disarms from the strip's ×, leaving the draft at its board scope", async () => {
    await seedDrafts()
    mount()
    await waitFor(() => expect(screen.getByTestId("editor-body")).toHaveTextContent("stream body"))

    await act(async () => {
      registeredConversationReplyHandler?.({ conversationId: "conv_1" })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(await db.composerTarget.get(hostScope)).toEqual({ host: hostScope, workspaceId, scope: boardScope })
    await waitFor(() => expect(screen.getByTestId("editor-body")).toHaveTextContent("board body"))

    await userEvent.click(screen.getByRole("button", { name: /cancel reply in conversation/i }))

    await waitFor(() => expect(screen.getByTestId("editor-body")).toHaveTextContent("stream body"))
    expect(await db.composerTarget.get(hostScope)).toBeUndefined()
    // Disarming means "this composer no longer points at C" — the draft written
    // for C stays a C draft.
    expect(await bodyOf(boardScope)).toBe("board body")
  })

  it("falls back to the stream scope when the target's conversation is gone", async () => {
    await seedDrafts()
    await setComposerTarget(workspaceId, hostScope, boardScope)
    notFound = true

    mount()

    await waitFor(() => expect(screen.getByTestId("editor-body")).toHaveTextContent("stream body"))
    expect(screen.queryByTestId("conversation-reply-strip")).not.toBeInTheDocument()
    await waitFor(async () => expect(await db.composerTarget.get(hostScope)).toBeUndefined())
    expect(await bodyOf(boardScope)).toBe("board body")
  })

  it("falls back to the stream scope on an encrypted stream, so the plaintext purge can't see a board scope", async () => {
    await seedDrafts()
    await setComposerTarget(workspaceId, hostScope, boardScope)
    e2eEnabled = true

    mount()

    // Positive sync point first: the stored row exists and the component has had
    // its liveQuery emission flushed. Without this the assertions below would run
    // before the target was ever observed and would pass with the carve-out gone.
    await waitFor(async () => expect(await db.composerTarget.get(hostScope)).toBeDefined())
    await settle()

    expect(screen.getByTestId("editor-body")).not.toHaveTextContent("board body")
    expect(screen.queryByTestId("conversation-reply-strip")).not.toBeInTheDocument()
    expect(await bodyOf(boardScope)).toBe("board body")
    // The target survives — the carve-out declines to apply it, it does not
    // delete it, so unlocking or leaving the encrypted stream restores the arm.
    expect(await db.composerTarget.get(hostScope)).toBeDefined()
  })

  it("releases the draft it stops hosting when disarmed, so it returns to the pile", async () => {
    await seedDrafts()
    await setComposerTarget(workspaceId, hostScope, boardScope)

    mount()
    await waitFor(() => expect(screen.getByTestId("conversation-reply-strip")).toBeInTheDocument())

    await act(async () => {
      screen.getByRole("button", { name: /cancel reply in conversation/i }).click()
    })

    // A draft checked out under a scope no composer shows is excluded from every
    // pile on the device, so disarming has to detach the pointer or the text is
    // reachable from nowhere.
    await waitFor(async () => expect(await db.composerLoaded.get(boardScope)).toBeUndefined())
    expect(await bodyOf(boardScope)).toBe("board body")
  })

  it("does not route a restored arm — a page load must not open the panel or focus", async () => {
    await seedDrafts()
    await setComposerTarget(workspaceId, hostScope, boardScope)
    // Someone continued the conversation in a thread overnight.
    lastActiveStreamId = "stream_thread"

    mount()

    await waitFor(() => expect(screen.getByTestId("conversation-reply-strip")).toBeInTheDocument())
    await settle()
    expect(openPanelSpy).not.toHaveBeenCalled()
    // Still armed and still editing the board draft — the strip is the whole
    // effect of a restored arm.
    expect(screen.getByTestId("editor-body")).toHaveTextContent("board body")
    expect(await db.composerTarget.get(hostScope)).toBeDefined()
  })

  it("does not re-route a gesture arm after navigating away and back", async () => {
    await seedDrafts()
    // Same-stream at arm time, so the gesture takes the focus branch and stays
    // armed rather than redirecting and disarming.
    lastActiveStreamId = streamId

    const view = mount()
    await waitFor(() => expect(screen.getByTestId("editor-body")).toHaveTextContent("stream body"))
    await act(async () => {
      registeredConversationReplyHandler?.({ conversationId: "conv_1" })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => expect(screen.getByTestId("conversation-reply-strip")).toBeInTheDocument())

    // The conversation moves into a thread while the user is elsewhere.
    lastActiveStreamId = "stream_thread"
    rerenderAtStream(view, "stream_other")
    await settle()
    rerenderAtStream(view, streamId)
    await waitFor(() => expect(screen.getByTestId("conversation-reply-strip")).toBeInTheDocument())
    await settle()

    // Coming back is a navigation, not a gesture: the arm shows and does nothing.
    expect(openPanelSpy).not.toHaveBeenCalled()
    expect(await db.composerTarget.get(hostScope)).toBeDefined()
  })

  it("still routes an arm made by the gesture when the conversation lives in a thread", async () => {
    await seedDrafts()
    lastActiveStreamId = "stream_thread"

    mount()
    await waitFor(() => expect(screen.getByTestId("editor-body")).toHaveTextContent("stream body"))

    await act(async () => {
      registeredConversationReplyHandler?.({ conversationId: "conv_1" })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await waitFor(() => expect(openPanelSpy).toHaveBeenCalled())
  })

  it("holds the arm when the board-post fetch fails for anything but a 404", async () => {
    await seedDrafts()
    await setComposerTarget(workspaceId, hostScope, boardScope)
    loadFailed = true

    mount()

    await waitFor(() => expect(screen.getByTestId("conversation-reply-strip")).toBeInTheDocument())
    await settle()
    // The target, the strip and the composer's scope all survive a 502.
    expect(await db.composerTarget.get(hostScope)).toBeDefined()
    expect(screen.getByTestId("editor-body")).toHaveTextContent("board body")
    expect(await bodyOf(boardScope)).toBe("board body")
  })

  it("disarms and restores when a ?stash= deep link names one of this stream's own rows", async () => {
    // A stashed row at the host's own scope: written, then detached.
    await upsertLoadedDraft(workspaceId, hostScope, { contentJson: makeDoc("stashed stream body"), attachments: [] })
    const stashedId = await stashLoadedDraft(workspaceId, hostScope)
    await upsertLoadedDraft(workspaceId, boardScope, { contentJson: makeDoc("board body"), attachments: [] })
    await act(async () => {
      await seedDraftCacheFromIdb(workspaceId)
    })
    await setComposerTarget(workspaceId, hostScope, boardScope)

    mount([`/?stash=${stashedId}`])

    await waitFor(() => expect(screen.getByTestId("editor-body")).toHaveTextContent("stashed stream body"))
    // The deep link is an explicit "work on this one": the arm yields to it.
    expect(await db.composerTarget.get(hostScope)).toBeUndefined()
    expect(screen.queryByTestId("conversation-reply-strip")).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("search-params")).toHaveTextContent(""))
    // The board draft stays where it was written (the × semantics).
    expect(await bodyOf(boardScope)).toBe("board body")
  })
})
