import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Router } from "react-router-dom"
import { useState } from "react"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as authModule from "@/auth"
import * as quoteReplyModule from "./quote-reply-context"
import * as conversationReplyModule from "./conversation-reply-context"
import * as useConversationsModule from "@/hooks/use-conversations"
import {
  consumeConversationReplyOpen,
  resetConversationReplyOpenStoreCache,
} from "@/stores/conversation-reply-open-store"
import * as composerModule from "@/components/composer"
import * as discussModule from "@/hooks/use-discuss-with-ariadne"
import * as streamContextBagModule from "@/hooks/use-stream-context-bag"
import { toast } from "sonner"
import { MessageInput, materializePendingAttachmentReferences } from "./message-input"
import type { JSONContent } from "@threa/types"

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})
const makeAttachmentDoc = (): JSONContent => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "attachmentReference",
          attrs: {
            id: "attach_1",
            filename: "pasted-image-1.png",
            mimeType: "image/png",
            sizeBytes: 1234,
            status: "uploaded",
            imageIndex: 1,
            error: null,
          },
        },
        { type: "text", text: " Check out this image:" },
      ],
    },
  ],
})

// Navigation capture: the component calls `useNavigate()` from
// `react-router-dom`, whose ESM namespace is frozen and therefore not
// spyable. Instead we render a bare `<Router>` with a custom `navigator`
// implementation that records all push/replace calls into `mockNavigate`
// using the same shape production code passes (`path, { replace }`).
const mockNavigate = vi.fn()

let mockMessageSendMode: "enter" | "cmdEnter" = "enter"

const mockSendMessage = vi.fn()
const mockOpenPanel = vi.fn()
let infoToastSpy: ReturnType<typeof vi.spyOn>
const mockClearDraft = vi.fn()
const mockResolveDraft = vi.fn()
const mockClearAttachments = vi.fn()
const mockSetContent = vi.fn()
const mockSetIsSending = vi.fn()
const mockHandleContentChange = vi.fn()
const mockHandleRemoveAttachment = vi.fn()
const mockHandleFileSelect = vi.fn()
const mockComposerFocus = vi.fn()
const mockComposerFocusAfterQuoteReply = vi.fn()
let mockSubmitContentOverride: JSONContent | undefined
let registeredQuoteReplyHandler:
  | ((data: {
      messageId: string
      streamId: string
      authorName: string
      authorId: string
      actorType: string
      snippet: string
    }) => void)
  | null = null
let registeredConversationReplyHandler: ((data: { conversationId: string }) => void) | null = null
const mockScheduleMutateAsync = vi.fn()
// Captured from the mocked ScheduledMessagesPicker so a test can drive the
// schedule flow (which lands on `handleSchedule`) without the real picker UI.
let capturedOnSchedule: ((when: Date) => void | Promise<void>) | null = null

// Composer state that tests can modify
let mockComposerState = {
  content: EMPTY_DOC as JSONContent,
  pendingAttachments: [] as Array<{
    id: string
    filename: string
    mimeType: string
    sizeBytes: number
    status: "uploading" | "uploaded" | "error"
    error?: string
  }>,
  uploadedIds: [] as string[],
  isUploading: false,
  hasFailed: false,
  canSend: false,
  isSending: false,
  isLoaded: true,
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  mockSendMessage.mockReset()
  mockSendMessage.mockResolvedValue({})
  mockScheduleMutateAsync.mockReset()
  mockScheduleMutateAsync.mockResolvedValue({})
  capturedOnSchedule = null
  mockOpenPanel.mockReset()
  infoToastSpy = vi.spyOn(toast, "info").mockImplementation(() => "toast-id")
  resetConversationReplyOpenStoreCache()
  mockNavigate.mockReset()
  mockMessageSendMode = "enter"
  mockComposerState = {
    content: EMPTY_DOC,
    pendingAttachments: [],
    uploadedIds: [],
    isUploading: false,
    hasFailed: false,
    canSend: false,
    isSending: false,
    isLoaded: true,
  }
  mockSubmitContentOverride = undefined
  registeredQuoteReplyHandler = null
  registeredConversationReplyHandler = null
  mockComposerFocus.mockReset()
  mockComposerFocusAfterQuoteReply.mockReset()

  vi.spyOn(contextsModule, "usePreferences").mockImplementation(
    () =>
      ({ preferences: { messageSendMode: mockMessageSendMode } }) as ReturnType<typeof contextsModule.usePreferences>
  )
  vi.spyOn(contextsModule, "useSocketStatus").mockReturnValue(
    "connected" as ReturnType<typeof contextsModule.useSocketStatus>
  )

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
  // useMentionStreamContext composes useStreamBootstrap + useUser + workspace
  // user role lookups; tests only care that the editor receives *some* context,
  // so stub to undefined which falls through to "no broadcast filter applied".
  vi.spyOn(hooksModule, "useMentionStreamContext").mockReturnValue(
    undefined as unknown as ReturnType<typeof hooksModule.useMentionStreamContext>
  )

  vi.spyOn(quoteReplyModule, "useQuoteReply").mockReturnValue({
    triggerQuoteReply: vi.fn(),
    registerHandler: (
      handler: (data: {
        messageId: string
        streamId: string
        authorName: string
        authorId: string
        actorType: string
        snippet: string
      }) => void
    ) => {
      registeredQuoteReplyHandler = handler
      return () => {
        if (registeredQuoteReplyHandler === handler) {
          registeredQuoteReplyHandler = null
        }
      }
    },
  } as unknown as ReturnType<typeof quoteReplyModule.useQuoteReply>)

  vi.spyOn(conversationReplyModule, "useConversationReply").mockReturnValue({
    triggerReplyInConversation: vi.fn(),
    registerHandler: (handler: (data: { conversationId: string }) => void) => {
      registeredConversationReplyHandler = handler
      return () => {
        if (registeredConversationReplyHandler === handler) {
          registeredConversationReplyHandler = null
        }
      }
    },
  } as unknown as ReturnType<typeof conversationReplyModule.useConversationReply>)
  // The armed-reply strip resolves its topic label via the board-post hook,
  // which needs the services context + query client; stub it with a fixed topic.
  // `recentMessages`/`conversation.streamId` default the conversation's last-active
  // stream to the rendered stream ("stream_456"), so the inline strip stays put —
  // the thread-follow redirect only fires when they point elsewhere (own test).
  vi.spyOn(useConversationsModule, "useConversationBoardPost").mockImplementation(
    (_workspaceId: string, conversationId: string | null) =>
      ({
        post: conversationId
          ? {
              conversation: { id: conversationId, streamId: "stream_456", topicSummary: "Pizza plans" },
              recentMessages: [],
            }
          : null,
        isLoading: false,
        notFound: false,
        refetch: vi.fn(),
      }) as unknown as ReturnType<typeof useConversationsModule.useConversationBoardPost>
  )

  vi.spyOn(contextsModule, "usePanel").mockReturnValue({
    openPanel: mockOpenPanel,
  } as unknown as ReturnType<typeof contextsModule.usePanel>)

  vi.spyOn(hooksModule, "useStreamOrDraft").mockReturnValue({
    sendMessage: mockSendMessage,
  } as unknown as ReturnType<typeof hooksModule.useStreamOrDraft>)
  // `useDiscussWithAriadne` internally pulls in `useCreateStream` → services
  // context + query client, none of which the test wrapper provides. Stub it
  // out; the command-routing branch is exercised by its own dedicated tests
  // further down (rather than via render()-level assertions).
  vi.spyOn(discussModule, "useDiscussWithAriadne").mockImplementation(
    () => vi.fn() as unknown as ReturnType<typeof discussModule.useDiscussWithAriadne>
  )
  // `useStreamContextBag` calls `useQuery` which the wrapper doesn't provide
  // a client for. Stub to an empty bag so the strip renders nothing — the
  // strip's own behavior is covered by its dedicated tests.
  vi.spyOn(streamContextBagModule, "useStreamContextBag").mockReturnValue({
    data: { bag: null, refs: [] },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof streamContextBagModule.useStreamContextBag>)
  vi.spyOn(hooksModule, "getDraftMessageKey").mockImplementation(() => "test-draft-key")
  vi.spyOn(hooksModule, "useDraftComposer").mockImplementation(
    () =>
      ({
        content: mockComposerState.content,
        setContent: mockSetContent,
        handleContentChange: mockHandleContentChange,
        pendingAttachments: mockComposerState.pendingAttachments,
        getPendingAttachmentsSnapshot: () => mockComposerState.pendingAttachments,
        uploadedIds: mockComposerState.uploadedIds,
        isUploading: mockComposerState.isUploading,
        hasFailed: mockComposerState.hasFailed,
        fileInputRef: { current: null },
        handleFileSelect: mockHandleFileSelect,
        handleRemoveAttachment: mockHandleRemoveAttachment,
        canSend: mockComposerState.canSend,
        isSending: mockComposerState.isSending,
        setIsSending: mockSetIsSending,
        clearDraft: mockClearDraft,
        resolveDraft: mockResolveDraft,
        clearAttachments: mockClearAttachments,
        isLoaded: mockComposerState.isLoaded,
      }) as unknown as ReturnType<typeof hooksModule.useDraftComposer>
  )
  vi.spyOn(hooksModule, "useComposerHeightPublish").mockImplementation(
    () => undefined as unknown as ReturnType<typeof hooksModule.useComposerHeightPublish>
  )
  // The composer's schedule-send entry needs the scheduled service via
  // ServicesProvider; tests run without that wrapper, so stub the hook to a
  // no-op mutation. The schedule path itself is exercised by the page tests.
  vi.spyOn(hooksModule, "useScheduleMessage").mockReturnValue({
    mutateAsync: mockScheduleMutateAsync,
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof hooksModule.useScheduleMessage>)
  // Capture the picker's onSchedule (bound to `handleSchedule`) so a test can
  // drive the schedule path directly; the real picker's date UI is exercised by
  // page tests.
  vi.spyOn(composerModule, "ScheduledMessagesPicker").mockImplementation((({
    onSchedule,
  }: {
    onSchedule: (when: Date) => void | Promise<void>
  }) => {
    capturedOnSchedule = onSchedule
    return <div data-testid="scheduled-messages-picker" />
  }) as unknown as typeof composerModule.ScheduledMessagesPicker)
  // Stash previews decrypt via the shared cache, which reads auth/session; these
  // tests render without an AuthProvider, so stub the batch hook to an empty map.
  vi.spyOn(hooksModule, "useDecryptedDraftPreviews").mockReturnValue(new Map())

  vi.spyOn(composerModule, "FloatingComposerShell").mockImplementation((({
    children,
    hidden,
  }: {
    children: ReactNode
    hidden?: boolean
  }) => (hidden ? null : <div>{children}</div>)) as unknown as typeof composerModule.FloatingComposerShell)
  vi.spyOn(composerModule, "MessageComposer").mockImplementation((({
    onSubmit,
    canSubmit,
    isSubmitting,
    hasFailed,
    pendingAttachments,
    composerRef,
    scheduledMessagesTrigger,
  }: {
    content: JSONContent
    onContentChange: (v: JSONContent) => void
    onSubmit: (content?: JSONContent) => void
    canSubmit: boolean
    isSubmitting: boolean
    hasFailed: boolean
    pendingAttachments: Array<{ id: string; filename: string; sizeBytes: number; status: string }>
    composerRef?: { current: { focus: () => void; focusAfterQuoteReply: () => void } | null }
    scheduledMessagesTrigger?: ReactNode
  }) => {
    if (composerRef) {
      composerRef.current = {
        focus: mockComposerFocus,
        focusAfterQuoteReply: mockComposerFocusAfterQuoteReply,
      }
    }

    return (
      <div data-testid="message-composer">
        <textarea data-testid="rich-editor" />
        {pendingAttachments.map((a) => (
          <div key={a.id}>
            <span>{a.filename}</span>
            <span>{a.sizeBytes >= 1024 ? `${(a.sizeBytes / 1024).toFixed(1)} KB` : `${a.sizeBytes} B`}</span>
            {a.status === "error" && <span>Failed</span>}
          </div>
        ))}
        <button onClick={() => onSubmit(mockSubmitContentOverride)} disabled={!canSubmit || hasFailed}>
          {isSubmitting ? "Sending..." : "Send"}
        </button>
        {scheduledMessagesTrigger}
      </div>
    )
  }) as unknown as typeof composerModule.MessageComposer)
})

function toPathString(to: { pathname: string; search?: string; hash?: string }): string {
  return `${to.pathname}${to.search ?? ""}${to.hash ?? ""}`
}

function Wrapper({ children }: { children: React.ReactNode }) {
  // Bare <Router> lets us inject a custom `navigator` that records every
  // push/replace as `mockNavigate(path, { replace })`. This reproduces the
  // shape production code passes to `useNavigate()` without needing to spy
  // on the frozen `react-router-dom` ESM namespace.
  const [location] = useState(() => ({
    pathname: "/",
    search: "",
    hash: "",
    state: null,
    key: "default",
  }))
  const navigator = {
    createHref: (to: unknown) => (typeof to === "string" ? to : JSON.stringify(to)),
    encodeLocation: (to: unknown) => {
      if (typeof to === "string") return { pathname: to, search: "", hash: "" }
      return to as { pathname: string; search: string; hash: string }
    },
    push: (to: unknown) => {
      const path =
        typeof to === "string" ? to : toPathString(to as { pathname: string; search?: string; hash?: string })
      mockNavigate(path, undefined)
    },
    replace: (to: unknown) => {
      const path =
        typeof to === "string" ? to : toPathString(to as { pathname: string; search?: string; hash?: string })
      mockNavigate(path, { replace: true })
    },
    go: () => {},
    listen: () => () => {},
    block: () => () => {},
  }
  return (
    <Router
      location={location}
      navigator={navigator as unknown as Parameters<typeof Router>[0]["navigator"]}
      navigationType={"POP" as Parameters<typeof Router>[0]["navigationType"]}
    >
      {children}
    </Router>
  )
}

function render$(ui: React.ReactElement) {
  return render(<Wrapper>{ui}</Wrapper>)
}

describe("MessageInput", () => {
  const workspaceId = "ws_123"
  const streamId = "stream_456"

  describe("rendering", () => {
    it("should render the message composer", () => {
      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      expect(screen.getByTestId("message-composer")).toBeInTheDocument()
      expect(screen.getByTestId("rich-editor")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument()
    })

    it("should disable send button when canSend is false", () => {
      mockComposerState.canSend = false

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      const sendButton = screen.getByRole("button", { name: /send/i })
      expect(sendButton).toBeDisabled()
    })

    it("should enable send button when canSend is true", () => {
      mockComposerState.canSend = true

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      const sendButton = screen.getByRole("button", { name: /send/i })
      expect(sendButton).not.toBeDisabled()
    })

    it("should not throw when toggling between disabled and enabled states", () => {
      const { rerender } = render(
        <Wrapper>
          <MessageInput workspaceId={workspaceId} streamId={streamId} disabled disabledReason="Read-only stream" />
        </Wrapper>
      )

      expect(screen.getByText("Read-only stream")).toBeInTheDocument()

      rerender(
        <Wrapper>
          <MessageInput workspaceId={workspaceId} streamId={streamId} />
        </Wrapper>
      )

      expect(screen.getByTestId("message-composer")).toBeInTheDocument()
    })
  })

  describe("sending messages", () => {
    it("should call sendMessage when send button is clicked", async () => {
      const helloContent = makeDoc("Hello world")
      mockComposerState.canSend = true
      mockComposerState.content = helloContent

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      const sendButton = screen.getByRole("button", { name: /send/i })
      await userEvent.click(sendButton)

      expect(mockSendMessage).toHaveBeenCalledWith({
        contentJson: helloContent,
        attachmentIds: undefined,
        attachments: undefined,
      })
    })

    it("sends an inline steer as an unchanged message with its attachments", async () => {
      const content = makeAttachmentDoc()
      content.content![0].content![1].text = " I want option 2 /steer and also pizza"
      mockComposerState.canSend = true
      mockComposerState.content = content
      vi.mocked(hooksModule.useStreamBootstrap).mockReturnValue({
        data: {
          commands: [{ name: "steer", description: "Steer", kind: "bot-runtime", scope: "stream" }],
        },
      } as unknown as ReturnType<typeof hooksModule.useStreamBootstrap>)

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)
      await userEvent.click(screen.getByRole("button", { name: /send/i }))

      expect(mockSendMessage).toHaveBeenCalledWith({
        contentJson: content,
        attachmentIds: ["attach_1"],
        attachments: [
          {
            id: "attach_1",
            filename: "pasted-image-1.png",
            mimeType: "image/png",
            sizeBytes: 1234,
          },
        ],
        steer: true,
      })
    })

    it("should resolve the draft and clear attachments after sending", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("Hello world")

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      const sendButton = screen.getByRole("button", { name: /send/i })
      await userEvent.click(sendButton)

      // Send uses the CAS resolve path (not the unconditional discard) so a copy
      // edited on another device survives as a stash entry.
      expect(mockResolveDraft).toHaveBeenCalled()
      expect(mockClearDraft).not.toHaveBeenCalled()
      expect(mockClearAttachments).toHaveBeenCalled()
    })

    it("should prefer the live editor content passed by the composer at submit time", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("stale")
      mockSubmitContentOverride = makeAttachmentDoc()

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      await userEvent.click(screen.getByRole("button", { name: /send/i }))

      expect(mockSendMessage).toHaveBeenCalledWith({
        contentJson: makeAttachmentDoc(),
        attachmentIds: ["attach_1"],
        attachments: [
          {
            id: "attach_1",
            filename: "pasted-image-1.png",
            mimeType: "image/png",
            sizeBytes: 1234,
          },
        ],
      })
    })

    it("should clear the composer immediately before send resolves", async () => {
      let resolveSend: ((value: unknown) => void) | undefined
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("Hello world")
      mockSendMessage.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSend = resolve
          })
      )

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      const sendButton = screen.getByRole("button", { name: /send/i })
      await userEvent.click(sendButton)

      expect(mockSetContent).toHaveBeenCalledWith(EMPTY_DOC)
      expect(mockResolveDraft).not.toHaveBeenCalled()

      resolveSend?.({})
    })

    it("should set isSending state during send", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("Hello world")

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      const sendButton = screen.getByRole("button", { name: /send/i })
      await userEvent.click(sendButton)

      expect(mockSetIsSending).toHaveBeenCalledWith(true)
      expect(mockSetIsSending).toHaveBeenCalledWith(false)
    })

    it("should navigate when sendMessage returns navigateTo", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("Hello world")
      mockSendMessage.mockResolvedValue({ navigateTo: "/w/ws_123/s/new_stream", replace: true })

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      const sendButton = screen.getByRole("button", { name: /send/i })
      await userEvent.click(sendButton)

      expect(mockNavigate).toHaveBeenCalledWith("/w/ws_123/s/new_stream", { replace: true })
    })
  })

  describe("quote replies", () => {
    it("inserts a quote block with one trailing paragraph so typing starts on the next line", () => {
      mockComposerState.content = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Before" }] }, { type: "paragraph" }],
      }

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      expect(registeredQuoteReplyHandler).not.toBeNull()

      registeredQuoteReplyHandler?.({
        messageId: "msg_123",
        streamId: "stream_456",
        authorName: "Ariadne",
        authorId: "user_123",
        actorType: "user",
        snippet: "The vibes are immaculate",
      })

      expect(mockSetContent).toHaveBeenCalledWith({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Before" }] },
          {
            type: "quoteReply",
            attrs: {
              messageId: "msg_123",
              streamId: "stream_456",
              authorName: "Ariadne",
              authorId: "user_123",
              actorType: "user",
              snippet: "The vibes are immaculate",
            },
          },
          { type: "paragraph" },
        ],
      })
      expect(mockComposerFocusAfterQuoteReply).toHaveBeenCalledTimes(1)
      expect(mockComposerFocus).not.toHaveBeenCalled()
    })
  })

  describe("reply in conversation", () => {
    it("arms the composer with a dismissible strip showing the conversation topic and focuses the editor", () => {
      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      expect(registeredConversationReplyHandler).not.toBeNull()
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))

      const strip = screen.getByTestId("conversation-reply-strip")
      expect(strip).toHaveTextContent("Replying in Pizza plans")
      expect(mockComposerFocus).toHaveBeenCalledTimes(1)
    })

    it("files the send into the armed conversation and clears the strip on success", async () => {
      const helloContent = makeDoc("late pizza take")
      mockComposerState.canSend = true
      mockComposerState.content = helloContent

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))

      await userEvent.click(screen.getByRole("button", { name: /send/i }))

      expect(mockSendMessage).toHaveBeenCalledWith({
        contentJson: helloContent,
        attachmentIds: undefined,
        attachments: undefined,
        conversation: { intent: "existing", conversationId: "conv_1" },
      })
      expect(screen.queryByTestId("conversation-reply-strip")).not.toBeInTheDocument()
    })

    it("carries the armed directive onto a scheduled send and clears the strip", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("send this later, in the conversation")

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))

      await act(async () => {
        await capturedOnSchedule?.(new Date("2099-01-01T00:00:00.000Z"))
      })

      expect(mockScheduleMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId,
          conversation: { intent: "existing", conversationId: "conv_1" },
        })
      )
      expect(screen.queryByTestId("conversation-reply-strip")).not.toBeInTheDocument()
    })

    it("stays silent when scheduling a reply whose conversation is live in this same stream", async () => {
      // Default mock: last-active stream === rendered stream, so the strip is
      // shown inline and a scheduled send behaves like the obvious happy path —
      // no toast (INV-63: the strip already shows what will happen).
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("later, same channel")

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))

      await act(async () => {
        await capturedOnSchedule?.(new Date("2099-01-01T00:00:00.000Z"))
      })

      expect(mockScheduleMutateAsync).toHaveBeenCalled()
      expect(infoToastSpy).not.toHaveBeenCalled()
    })

    it("signals that a scheduled reply will still file into a drifted (thread-live) conversation", async () => {
      // Arm same-stream (route latches inline, strip stays), then a background
      // update moves the conversation into a thread — the latch keeps the arm put
      // rather than evicting to the panel. A live send would hand off; a scheduled
      // send can't, so it files by id at fire time. Surface that so the deferred
      // reply doesn't read as a flat channel send (INV-63).
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("later, into the thread's conversation")

      const { rerender } = render(
        <Wrapper>
          <MessageInput workspaceId={workspaceId} streamId={streamId} />
        </Wrapper>
      )
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))
      expect(mockOpenPanel).not.toHaveBeenCalled()

      vi.spyOn(useConversationsModule, "useConversationBoardPost").mockReturnValue({
        post: {
          conversation: { id: "conv_1", streamId, topicSummary: "Pizza plans" },
          recentMessages: [{ streamId: "thread_789" }],
        },
        isLoading: false,
        notFound: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useConversationsModule.useConversationBoardPost>)
      rerender(
        <Wrapper>
          <MessageInput workspaceId={workspaceId} streamId={streamId} />
        </Wrapper>
      )
      expect(mockOpenPanel).not.toHaveBeenCalled()

      await act(async () => {
        await capturedOnSchedule?.(new Date("2099-01-01T00:00:00.000Z"))
      })

      expect(mockScheduleMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation: { intent: "existing", conversationId: "conv_1" },
        })
      )
      expect(infoToastSpy).toHaveBeenCalled()
    })

    it("schedules with no directive when the composer isn't armed", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("just a normal scheduled message")

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      await act(async () => {
        await capturedOnSchedule?.(new Date("2099-01-01T00:00:00.000Z"))
      })

      expect(mockScheduleMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ conversation: undefined }))
    })

    it("keeps the filing armed when the send fails, so a retry still files", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("doomed")
      mockSendMessage.mockRejectedValue(new Error("stream creation failed"))

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))

      await userEvent.click(screen.getByRole("button", { name: /send/i }))

      expect(screen.getByTestId("conversation-reply-strip")).toBeInTheDocument()
    })

    it("dismissing the strip disarms the filing — the next send carries no directive", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("just a normal message")

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))

      await userEvent.click(screen.getByRole("button", { name: /cancel reply in conversation/i }))
      expect(screen.queryByTestId("conversation-reply-strip")).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole("button", { name: /send/i }))

      expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversation: undefined }))
    })

    it("hands off to the conversation panel when the conversation is live in a thread (thread-follow)", () => {
      // The conversation's most-recently-active stream is a thread (`thread_789`),
      // not the rendered channel (`stream_456`) — a flat send here would
      // re-interleave the channel, so the composer redirects to the conversation
      // panel and asks it to open its reply composer instead of arming inline.
      vi.spyOn(useConversationsModule, "useConversationBoardPost").mockImplementation(
        (_workspaceId: string, conversationId: string | null) =>
          ({
            post: conversationId
              ? {
                  conversation: { id: conversationId, streamId, topicSummary: "Pizza plans" },
                  recentMessages: [{ streamId: "thread_789" }],
                }
              : null,
            isLoading: false,
            notFound: false,
            refetch: vi.fn(),
          }) as unknown as ReturnType<typeof useConversationsModule.useConversationBoardPost>
      )

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))

      expect(mockOpenPanel).toHaveBeenCalledWith(contextsModule.createConversationPanelId("conv_1"))
      // The panel's composer is asked to open, and no inline strip is left behind.
      expect(consumeConversationReplyOpen("conv_1")).toBe(true)
      expect(screen.queryByTestId("conversation-reply-strip")).not.toBeInTheDocument()
      // The channel composer is never focused — focus would pop the mobile keyboard
      // on the composer we're about to leave for the panel.
      expect(mockComposerFocus).not.toHaveBeenCalled()
    })

    it("hands off to the panel instead of filing flat when the projection isn't resolved at send time", async () => {
      // The board-post projection hasn't loaded (post null), so the last-active
      // stream is unknown. A flat `{intent:"existing"}` send could re-interleave the
      // channel if the conversation is actually thread-live — so the send is routed
      // to the panel instead, and nothing is filed inline.
      vi.spyOn(useConversationsModule, "useConversationBoardPost").mockReturnValue({
        post: null,
        isLoading: true,
        notFound: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useConversationsModule.useConversationBoardPost>)
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("late pizza take")

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))

      await userEvent.click(screen.getByRole("button", { name: /send/i }))

      expect(mockOpenPanel).toHaveBeenCalledWith(contextsModule.createConversationPanelId("conv_1"))
      expect(consumeConversationReplyOpen("conv_1")).toBe(true)
      // No flat send — routing was unresolved, so the directive send never fired.
      expect(mockSendMessage).not.toHaveBeenCalled()
      // The redirect is signalled — the panel can cover this view, so the kept
      // draft needs a word or the message reads as vanished (INV-63).
      expect(infoToastSpy).toHaveBeenCalled()
    })

    it("keeps the inline reply put when a background update later moves the conversation to a thread", () => {
      // Armed and resolved same-stream (strip shown, composer focused). A live
      // board-post update then reports the conversation living in a thread — the
      // route is latched at arm time, so it must NOT evict the user to the panel
      // mid-composition without any action from them.
      const { rerender } = render(
        <Wrapper>
          <MessageInput workspaceId={workspaceId} streamId={streamId} />
        </Wrapper>
      )
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))
      expect(mockComposerFocus).toHaveBeenCalledTimes(1)
      expect(mockOpenPanel).not.toHaveBeenCalled()

      vi.spyOn(useConversationsModule, "useConversationBoardPost").mockReturnValue({
        post: {
          conversation: { id: "conv_1", streamId, topicSummary: "Pizza plans" },
          recentMessages: [{ streamId: "thread_789" }],
        },
        isLoading: false,
        notFound: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useConversationsModule.useConversationBoardPost>)
      rerender(
        <Wrapper>
          <MessageInput workspaceId={workspaceId} streamId={streamId} />
        </Wrapper>
      )

      expect(mockOpenPanel).not.toHaveBeenCalled()
    })

    it("does not open the panel when navigating away from an armed same-stream reply", () => {
      // Arm a same-stream reply (mock last-active === rendered stream) — inline strip,
      // no redirect. Switching streams must disarm quietly, never redirect the
      // now-stale armed conversation into the panel.
      const { rerender } = render(
        <Wrapper>
          <MessageInput workspaceId={workspaceId} streamId={streamId} />
        </Wrapper>
      )
      act(() => registeredConversationReplyHandler?.({ conversationId: "conv_1" }))
      expect(screen.getByTestId("conversation-reply-strip")).toBeInTheDocument()
      expect(mockOpenPanel).not.toHaveBeenCalled()

      rerender(
        <Wrapper>
          <MessageInput workspaceId={workspaceId} streamId="stream_other" />
        </Wrapper>
      )

      expect(mockOpenPanel).not.toHaveBeenCalled()
      expect(screen.queryByTestId("conversation-reply-strip")).not.toBeInTheDocument()
    })
  })

  describe("attachment display", () => {
    it("should show pending attachments", () => {
      mockComposerState.pendingAttachments = [
        {
          id: "attach_123",
          filename: "test.txt",
          mimeType: "text/plain",
          sizeBytes: 1024,
          status: "uploaded",
        },
      ]

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      expect(screen.getByText("test.txt")).toBeInTheDocument()
      expect(screen.getByText("1.0 KB")).toBeInTheDocument()
    })

    it("should show failed attachment with error state", () => {
      mockComposerState.pendingAttachments = [
        {
          id: "temp_123",
          filename: "failed.txt",
          mimeType: "text/plain",
          sizeBytes: 1024,
          status: "error",
          error: "Upload failed",
        },
      ]
      mockComposerState.hasFailed = true

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      expect(screen.getByText("failed.txt")).toBeInTheDocument()
      expect(screen.getByText("Failed")).toBeInTheDocument()
    })

    it("should disable send button when uploads have failed", () => {
      mockComposerState.hasFailed = true

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      const sendButton = screen.getByRole("button", { name: /send/i })
      expect(sendButton).toBeDisabled()
    })

    it("should include attachment IDs when sending", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = EMPTY_DOC
      mockComposerState.uploadedIds = ["attach_123"]
      mockComposerState.pendingAttachments = [
        {
          id: "attach_123",
          filename: "test.txt",
          mimeType: "text/plain",
          sizeBytes: 1024,
          status: "uploaded",
        },
      ]

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      const sendButton = screen.getByRole("button", { name: /send/i })
      await userEvent.click(sendButton)

      expect(mockSendMessage).toHaveBeenCalledWith({
        contentJson: {
          type: "doc",
          content: [
            { type: "paragraph" },
            {
              type: "paragraph",
              content: [
                {
                  type: "attachmentReference",
                  attrs: {
                    id: "attach_123",
                    filename: "test.txt",
                    mimeType: "text/plain",
                    sizeBytes: 1024,
                    status: "uploaded",
                    imageIndex: null,
                    error: null,
                  },
                },
              ],
            },
          ],
        },
        attachmentIds: ["attach_123"],
        attachments: [{ id: "attach_123", filename: "test.txt", mimeType: "text/plain", sizeBytes: 1024 }],
      })
    })

    it("should materialize uploaded attachment references before sending", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Check this " },
              {
                type: "attachmentReference",
                attrs: {
                  id: "temp_123",
                  filename: "pasted-image-1.png",
                  mimeType: "image/png",
                  sizeBytes: 68,
                  status: "uploading",
                  imageIndex: null,
                  error: null,
                },
              },
            ],
          },
        ],
      }
      mockComposerState.uploadedIds = ["attach_123"]
      mockComposerState.pendingAttachments = [
        {
          id: "attach_123",
          filename: "pasted-image-1.png",
          mimeType: "image/png",
          sizeBytes: 68,
          status: "uploaded",
        },
      ]

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      await userEvent.click(screen.getByRole("button", { name: /send/i }))

      expect(mockSendMessage).toHaveBeenCalledWith({
        contentJson: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Check this " },
                {
                  type: "attachmentReference",
                  attrs: {
                    id: "attach_123",
                    filename: "pasted-image-1.png",
                    mimeType: "image/png",
                    sizeBytes: 68,
                    status: "uploaded",
                    imageIndex: 1,
                    error: null,
                  },
                },
              ],
            },
          ],
        },
        attachmentIds: ["attach_123"],
        attachments: [{ id: "attach_123", filename: "pasted-image-1.png", mimeType: "image/png", sizeBytes: 68 }],
      })
    })
  })

  describe("attachment reference materialization", () => {
    it("should keep existing numbered image references stable", () => {
      const content: JSONContent = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "attachmentReference",
                attrs: {
                  id: "attach_123",
                  filename: "pasted-image-1.png",
                  mimeType: "image/png",
                  sizeBytes: 68,
                  status: "uploaded",
                  imageIndex: 3,
                  error: null,
                },
              },
            ],
          },
        ],
      }

      expect(
        materializePendingAttachmentReferences(content, [
          {
            id: "attach_123",
            filename: "pasted-image-1.png",
            mimeType: "image/png",
            sizeBytes: 68,
            status: "uploaded",
          },
        ])
      ).toEqual(content)
    })

    it("materializes a still-uploading reserved attachment with persisted status 'uploaded'", () => {
      // Stored contentJson is never revisited when the bytes land, so the node
      // must not freeze a transient "uploading" into the message (it would
      // spin forever and be dropped from content_markdown — the serializer
      // skips uploading nodes). Live upload state rides the attachment
      // summaries + socket patches instead.
      const materialized = materializePendingAttachmentReferences(EMPTY_DOC, [
        {
          id: "attach_pending",
          filename: "large.mov",
          mimeType: "video/quicktime",
          sizeBytes: 1024,
          status: "uploading" as const,
        },
      ])
      expect(materialized).toMatchObject({
        content: [
          {},
          {
            content: [{ attrs: { id: "attach_pending", status: "uploaded" } }],
          },
        ],
      })
    })

    it("excludes still-reserving (temp-id) and failed attachments from the message", () => {
      const materialized = materializePendingAttachmentReferences(EMPTY_DOC, [
        { id: "temp_1", filename: "a.png", mimeType: "image/png", sizeBytes: 1, status: "uploading" as const },
        { id: "attach_err", filename: "b.png", mimeType: "image/png", sizeBytes: 1, status: "error" as const },
      ])
      expect(materialized).toEqual(EMPTY_DOC)
    })

    it("should append uploaded attachments that are missing from the editor document", () => {
      expect(
        materializePendingAttachmentReferences(EMPTY_DOC, [
          {
            id: "attach_123",
            filename: "pasted-image-1.png",
            mimeType: "image/png",
            sizeBytes: 68,
            status: "uploaded",
          },
        ])
      ).toEqual({
        type: "doc",
        content: [
          { type: "paragraph" },
          {
            type: "paragraph",
            content: [
              {
                type: "attachmentReference",
                attrs: {
                  id: "attach_123",
                  filename: "pasted-image-1.png",
                  mimeType: "image/png",
                  sizeBytes: 68,
                  status: "uploaded",
                  imageIndex: 1,
                  error: null,
                },
              },
            ],
          },
        ],
      })
    })
  })

  describe("error handling", () => {
    it("should show error message when sendMessage fails", async () => {
      mockComposerState.canSend = true
      mockComposerState.content = makeDoc("Hello world")
      mockSendMessage.mockRejectedValue(new Error("Network error"))

      render$(<MessageInput workspaceId={workspaceId} streamId={streamId} />)

      const sendButton = screen.getByRole("button", { name: /send/i })
      await userEvent.click(sendButton)

      expect(screen.getByText("Failed to create stream. Please try again.")).toBeInTheDocument()
    })
  })
})
