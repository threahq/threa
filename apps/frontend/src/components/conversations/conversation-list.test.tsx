import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ConversationWithStaleness } from "@threahq/types"
import { ConversationList } from "./conversation-list"
import { PanelProvider } from "@/contexts"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import { TooltipProvider } from "@/components/ui/tooltip"

function conversation(overrides: Partial<ConversationWithStaleness> = {}): ConversationWithStaleness {
  return {
    id: "conv_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    topicSummary: "Topic",
    messageIds: ["msg_1"],
    participantIds: ["usr_1"],
    status: "active",
    completenessScore: 2,
    effectiveCompleteness: 2,
    temporalStaleness: 0,
    lastActivityAt: "2026-07-20T10:00:00.000Z",
    createdAt: "2026-07-20T09:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  } as unknown as ConversationWithStaleness
}

function renderList(conversations: ConversationWithStaleness[]) {
  vi.spyOn(hooksModule, "useConversations").mockReturnValue({
    conversations,
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof hooksModule.useConversations>)

  return render(
    <MemoryRouter>
      <TooltipProvider>
        <PanelProvider>
          <ConversationList workspaceId="ws_1" streamId="stream_1" />
        </PanelProvider>
      </TooltipProvider>
    </MemoryRouter>
  )
}

describe("ConversationList", () => {
  beforeEach(() => {
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { timezone: "UTC", locale: "en-US" },
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  })
  afterEach(() => vi.restoreAllMocks())

  const rows = [
    conversation({ id: "conv_old", topicSummary: "Oldest", lastActivityAt: "2026-07-18T10:00:00.000Z" }),
    conversation({ id: "conv_new", topicSummary: "Newest", lastActivityAt: "2026-07-22T10:00:00.000Z" }),
    conversation({
      id: "conv_mid",
      topicSummary: "Middle",
      status: "resolved",
      lastActivityAt: "2026-07-20T10:00:00.000Z",
    }),
  ]

  it("renders one flat list ordered by lastActivityAt desc, ignoring status", () => {
    renderList(rows)
    const topics = screen.getAllByText(/Oldest|Newest|Middle/).map((el) => el.textContent)
    expect(topics).toEqual(["Newest", "Middle", "Oldest"])
  })

  it("renders no classifier status sections", () => {
    renderList(rows)
    for (const heading of ["Active", "Stalled", "Resolved"]) {
      expect(screen.queryByText(new RegExp(`^${heading}( \\(\\d+\\))?$`))).not.toBeInTheDocument()
    }
  })
})
