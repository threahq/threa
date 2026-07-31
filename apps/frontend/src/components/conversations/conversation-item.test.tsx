import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ConversationWithStaleness } from "@threa/types"
import { ConversationItem } from "./conversation-item"
import { PanelProvider } from "@/contexts"
import * as contextsModule from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"

function conversation(overrides: Partial<ConversationWithStaleness> = {}): ConversationWithStaleness {
  return {
    id: "conv_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    topicSummary: "Pricing for the new tier",
    messageIds: ["msg_1", "msg_2"],
    participantIds: ["usr_1"],
    status: "stalled",
    completenessScore: 2,
    effectiveCompleteness: 2,
    temporalStaleness: 5,
    lastActivityAt: "2026-07-20T10:00:00.000Z",
    createdAt: "2026-07-20T09:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  } as unknown as ConversationWithStaleness
}

function renderItem(conv: ConversationWithStaleness) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <PanelProvider>
          <ConversationItem workspaceId="ws_1" conversation={conv} isExpanded={false} onToggle={() => {}} />
        </PanelProvider>
      </TooltipProvider>
    </MemoryRouter>
  )
}

describe("ConversationItem", () => {
  beforeEach(() => {
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { timezone: "UTC", locale: "en-US" },
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  })
  afterEach(() => vi.restoreAllMocks())

  it("shows the topic and message count", () => {
    renderItem(conversation())
    expect(screen.getByText("Pricing for the new tier")).toBeInTheDocument()
    expect(screen.getByText("2 messages")).toBeInTheDocument()
  })

  it("renders no classifier-judgment surfaces — no status badge, no completeness segments", () => {
    const { container } = renderItem(conversation({ status: "stalled" } as Partial<ConversationWithStaleness>))
    for (const label of ["Active", "Stalled", "Resolved"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
    // The completeness meter carried a tooltip naming the score; none may remain.
    expect(container.querySelector("[aria-label^='Completeness']")).toBeNull()
    expect(screen.queryByText(/Completeness/)).not.toBeInTheDocument()
  })

  it("does not dim a temporally stale conversation — staleness no longer drives the row", () => {
    const { container } = renderItem(conversation({ temporalStaleness: 6 } as Partial<ConversationWithStaleness>))
    expect(container.querySelector(".opacity-60")).toBeNull()
  })
})
