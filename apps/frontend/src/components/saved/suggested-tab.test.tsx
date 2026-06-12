import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { SavedSuggestionView } from "@threa/types"
import { SuggestedTab } from "./suggested-tab"
import { ServicesProvider } from "@/contexts"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as contextsModule from "@/contexts"

const WORKSPACE_ID = "ws_1"

function makeSuggestion(overrides: Partial<SavedSuggestionView> = {}): SavedSuggestionView {
  const now = "2026-06-12T12:00:00.000Z"
  return {
    id: "sugg_1",
    workspaceId: WORKSPACE_ID,
    userId: "usr_me",
    streamId: "stream_1",
    conversationId: "conv_1",
    title: "Send the Q3 invoice",
    context: "Acme is waiting on it",
    sourceMessageIds: ["msg_1"],
    dueAt: null,
    status: "suggested",
    savedMessageId: null,
    createdAt: now,
    statusChangedAt: now,
    ...overrides,
  }
}

function mountTab(suggestions: SavedSuggestionView[], serviceOverrides = {}) {
  const list = vi.fn(async () => ({ suggestions, nextCursor: null }))
  const accept = vi.fn(async () => ({
    suggestion: { ...suggestions[0]!, status: "accepted" as const },
    saved: { id: "saved_new" },
  }))
  const dismiss = vi.fn(async () => ({ ...suggestions[0]!, status: "dismissed" as const }))
  const savedSuggestions = { list, accept, dismiss, ...serviceOverrides }

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider services={{ savedSuggestions: savedSuggestions as never }}>
        <MemoryRouter>
          <SuggestedTab workspaceId={WORKSPACE_ID} />
        </MemoryRouter>
      </ServicesProvider>
    </QueryClientProvider>
  )
  return { list, accept, dismiss }
}

beforeEach(() => {
  // SavedSuggestionItem resolves the stream label via the workspace caches.
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  // RelativeTime (rendered in the row footer) reads timezone/locale from the
  // preferences context.
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
})

afterEach(() => vi.restoreAllMocks())

describe("SuggestedTab", () => {
  it("renders the empty state when there are no suggestions", async () => {
    mountTab([])
    expect(await screen.findByText("No suggestions right now")).toBeTruthy()
  })

  it("renders a suggestion's title and context", async () => {
    mountTab([makeSuggestion()])
    expect(await screen.findByText("Send the Q3 invoice")).toBeTruthy()
    expect(screen.getByText("Acme is waiting on it")).toBeTruthy()
  })

  it("accepts a suggestion through the service when Add is clicked", async () => {
    const { accept } = mountTab([makeSuggestion()])
    const addButton = await screen.findByTitle("Add to Saved")
    fireEvent.click(addButton)
    await waitFor(() => expect(accept).toHaveBeenCalledWith(WORKSPACE_ID, "sugg_1"))
  })

  it("dismisses a suggestion through the service when the dismiss button is clicked", async () => {
    const { dismiss } = mountTab([makeSuggestion()])
    const dismissButton = await screen.findByTitle("Dismiss")
    fireEvent.click(dismissButton)
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith(WORKSPACE_ID, "sugg_1"))
  })
})
