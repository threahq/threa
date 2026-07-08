import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ServicesProvider } from "@/contexts"
import { ConversationSplitDialog } from "./conversation-split-dialog"
import type { SplitProposal } from "@/api/conversations"

function proposal(overrides: Partial<SplitProposal> = {}): SplitProposal {
  return {
    conversationId: "conv_1",
    groups: [
      { title: "Fable pricing", summary: "Cost of Fable", messageIds: ["m1", "m2", "m3"] },
      { title: "Fable på svenska", summary: "Swedish support", messageIds: ["m4"] },
    ],
    confidence: 0.9,
    reasoning: "two topics",
    ...overrides,
  }
}

function renderDialog(
  services: { proposeSplit: ReturnType<typeof vi.fn>; applySplit: ReturnType<typeof vi.fn> },
  onOpenChange = vi.fn()
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider services={{ conversations: services as never }}>
        <ConversationSplitDialog
          workspaceId="ws_1"
          streamId="stream_1"
          conversationId="conv_1"
          open
          onOpenChange={onOpenChange}
        />
      </ServicesProvider>
    </QueryClientProvider>
  )
  return { onOpenChange }
}

describe("ConversationSplitDialog", () => {
  beforeEach(() => vi.clearAllMocks())

  it("renders the proposed groups and applies the confirmed split", async () => {
    const applySplit = vi.fn().mockResolvedValue({ conversation: {}, newConversations: [] })
    const proposeSplit = vi.fn().mockResolvedValue(proposal())
    const { onOpenChange } = renderDialog({ proposeSplit, applySplit })

    // Both proposed groups shown, first kept in this conversation, second new.
    expect(await screen.findByText("Fable pricing")).toBeInTheDocument()
    expect(screen.getByText("Fable på svenska")).toBeInTheDocument()
    expect(screen.getByText("This conversation")).toBeInTheDocument()
    expect(screen.getByText("New conversation")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /Split into 2 conversations/ }))

    await waitFor(() =>
      expect(applySplit).toHaveBeenCalledWith("ws_1", "conv_1", [
        { title: "Fable pricing", summary: "Cost of Fable", messageIds: ["m1", "m2", "m3"] },
        { title: "Fable på svenska", summary: "Swedish support", messageIds: ["m4"] },
      ])
    )
    // Success is silent — the dialog just closes.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("shows a no-split message and no confirm button for a single-group proposal", async () => {
    const applySplit = vi.fn()
    const proposeSplit = vi
      .fn()
      .mockResolvedValue(proposal({ groups: [{ title: "One topic", summary: null, messageIds: ["m1", "m2"] }] }))
    renderDialog({ proposeSplit, applySplit })

    expect(await screen.findByText(/no split suggested/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Split into/ })).not.toBeInTheDocument()
    expect(applySplit).not.toHaveBeenCalled()
  })
})
