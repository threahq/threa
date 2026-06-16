import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Router } from "react-router-dom"
import { useState } from "react"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as authModule from "@/auth"
import * as quoteReplyModule from "./quote-reply-context"
import * as composerModule from "@/components/composer"
import * as discussModule from "@/hooks/use-discuss-with-ariadne"
import * as streamContextBagModule from "@/hooks/use-stream-context-bag"
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
    mutateAsync: vi.fn().mockResolvedValue({}),
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof hooksModule.useScheduleMessage>)
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
  }: {
    content: JSONContent
    onContentChange: (v: JSONContent) => void
    onSubmit: (content?: JSONContent) => void
    canSubmit: boolean
    isSubmitting: boolean
    hasFailed: boolean
    pendingAttachments: Array<{ id: string; filename: string; sizeBytes: number; status: string }>
    composerRef?: { current: { focus: () => void; focusAfterQuoteReply: () => void } | null }
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
