import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN, type SavedMessageView } from "@threahq/types"
import { SavedEditDialog } from "./saved-edit-dialog"
import { ServicesProvider } from "@/contexts"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as contextsModule from "@/contexts"
import * as useMobileModule from "@/hooks/use-mobile"

const WORKSPACE_ID = "ws_1"

function makeView(overrides: Partial<SavedMessageView> = {}): SavedMessageView {
  const now = "2026-01-01T00:00:00.000Z"
  return {
    id: "saved_1",
    workspaceId: WORKSPACE_ID,
    userId: "usr_me",
    messageId: "msg_1",
    streamId: "stream_ch",
    conversationId: null,
    status: "saved",
    title: null,
    note: null,
    remindAt: null,
    reminderSentAt: null,
    savedAt: now,
    statusChangedAt: now,
    unavailableReason: null,
    message: {
      authorId: "usr_peer",
      authorType: "user",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "**ship** the Q3 invoice",
      createdAt: now,
      editedAt: null,
      streamName: null,
    },
    ...overrides,
  }
}

function mount(saved: SavedMessageView) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider>
        <SavedEditDialog open onOpenChange={() => {}} workspaceId={WORKSPACE_ID} saved={saved} />
      </ServicesProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([
    { id: "stream_ch", type: "channel", slug: "general", displayName: null },
  ] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
    { id: "usr_peer", name: "Ada Lovelace" },
  ] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
})

afterEach(() => vi.restoreAllMocks())

describe("SavedEditDialog source message preview", () => {
  it("shows author, stream, and markdown-stripped content for message-anchored items", () => {
    mount(makeView())

    expect(screen.getByText("Ada Lovelace")).toBeTruthy()
    expect(screen.getByText("in #general")).toBeTruthy()
    // INV-60: literal **bold** syntax must never reach the preview.
    expect(screen.getByText("ship the Q3 invoice")).toBeTruthy()
    expect(screen.queryByText("**ship** the Q3 invoice")).toBeNull()
  })

  it("shows the deleted fallback when the message is gone", () => {
    mount(makeView({ message: null, unavailableReason: "deleted" }))
    expect(screen.getByText("Original message was deleted")).toBeTruthy()
  })

  it("shows the encrypted placeholder for E2E messages", () => {
    mount(makeView({ message: { ...makeView().message!, contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN } }))
    expect(screen.getByText("🔒 Encrypted message")).toBeTruthy()
  })

  it("renders no preview block for standalone items, but does render the title field", () => {
    mount(makeView({ messageId: null, streamId: null, message: null, title: "Call the landlord" }))
    expect(screen.queryByText(/^in /)).toBeNull()
    expect(screen.getByLabelText("Title")).toBeTruthy()
  })
})
