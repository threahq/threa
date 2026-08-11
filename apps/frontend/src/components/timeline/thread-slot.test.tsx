import { beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { MessageAgentActivity } from "@/hooks"
import type { ThreadSummary } from "@threa/types"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as workspaceEmojiModule from "@/hooks/use-workspace-emoji"
import * as relativeTimeModule from "@/components/relative-time"
import { ThreadSlot } from "./thread-slot"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(contextsModule, "useTrace").mockReturnValue({
    getTraceUrl: (id: string) => `/trace/${id}`,
  } as ReturnType<typeof contextsModule.useTrace>)
  vi.spyOn(hooksModule, "getStepLabel").mockImplementation((step: string | null) =>
    step ? `Step-${step}` : "Thinking"
  )
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: (id: string) => `Name-${id.slice(-4)}`,
    getActorAvatar: (id: string) => ({ fallback: id.slice(0, 2).toUpperCase(), avatarUrl: null }),
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(workspaceEmojiModule, "useWorkspaceEmoji").mockReturnValue({
    toEmoji: () => null,
  } as unknown as ReturnType<typeof workspaceEmojiModule.useWorkspaceEmoji>)
  vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation((({ date }: { date: string }) => (
    <time dateTime={date}>{date}</time>
  )) as unknown as typeof relativeTimeModule.RelativeTime)
})

function makeActivity(overrides: Partial<MessageAgentActivity> = {}): MessageAgentActivity {
  return {
    sessionId: "session_1",
    personaName: "Ariadne",
    currentStepType: "workspace_search",
    stepCount: 1,
    messageCount: 0,
    substep: null,
    ...overrides,
  }
}

const summary: ThreadSummary = {
  lastReplyAt: "2026-04-19T12:00:00.000Z",
  participants: [{ id: "user_alice", type: "user" }],
  latestReply: {
    messageId: "msg_1",
    actorId: "user_alice",
    actorType: "user",
    contentMarkdown: "first reply",
  },
}

function renderSlot(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe("ThreadSlot", () => {
  it("renders nothing when there's no activity and no replies", () => {
    const { container } = renderSlot(
      <ThreadSlot activity={undefined} replyCount={0} threadHref={null} summary={undefined} workspaceId="ws_1" />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the thinking row when session is active with no replies yet", () => {
    renderSlot(
      <ThreadSlot activity={makeActivity()} replyCount={0} threadHref={null} summary={undefined} workspaceId="ws_1" />
    )
    expect(screen.getByText("Ariadne")).toBeInTheDocument()
    expect(screen.getByText(/is step-workspace_search…$/)).toBeInTheDocument()
  })

  it("renders the ThreadCard when replies exist", () => {
    renderSlot(
      <ThreadSlot activity={undefined} replyCount={2} threadHref="/thread/1" summary={summary} workspaceId="ws_1" />
    )
    expect(screen.getByText("2 replies")).toBeInTheDocument()
  })

  it("renders the ThreadCard with activity indicator when both are present (mid-session thread)", () => {
    const { container } = renderSlot(
      <ThreadSlot
        activity={makeActivity()}
        replyCount={1}
        threadHref="/thread/1"
        summary={summary}
        workspaceId="ws_1"
      />
    )
    expect(screen.getByText("1 reply")).toBeInTheDocument()
    // Card's active dot (animate-ping) is present when `isActive`.
    expect(container.querySelector(".animate-ping")).not.toBeNull()
  })

  it("owns the gold left-line so the card suppresses its own (no double-draw)", () => {
    const { container } = renderSlot(
      <ThreadSlot activity={undefined} replyCount={2} threadHref="/thread/1" summary={summary} workspaceId="ws_1" />
    )
    // Exactly one 2px gold line should be in the DOM. The slot's line is a
    // `<span class="w-[2px]">`; the card's `before:` line is a pseudo-element
    // not in the DOM, so we assert the persistent line is present and there
    // is no duplicate.
    const lines = container.querySelectorAll(".w-\\[2px\\]")
    expect(lines.length).toBe(1)
  })

  it("is visible for a draft with no thread yet, rendering the draft card at the draft panel url", () => {
    renderSlot(
      <ThreadSlot
        activity={undefined}
        replyCount={0}
        threadHref={null}
        summary={undefined}
        workspaceId="ws_1"
        draft={{ draftId: "draft_1", preview: "typed but unsent", attachmentCount: 0, isCheckedOut: true }}
        draftHref="/panel/draft:stream_1:msg_1"
      />
    )
    expect(screen.getByRole("link")).toHaveAttribute("href", "/panel/draft:stream_1:msg_1")
    expect(screen.getByText("Draft")).toBeInTheDocument()
    expect(screen.getByText("typed but unsent")).toBeInTheDocument()
  })

  it("stays null for a draft with nowhere to point (no thread and no draft url)", () => {
    const { container } = renderSlot(
      <ThreadSlot
        activity={undefined}
        replyCount={0}
        threadHref={null}
        summary={undefined}
        workspaceId="ws_1"
        draft={{ draftId: "draft_1", preview: "typed but unsent", attachmentCount: 0, isCheckedOut: true }}
        draftHref={null}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it("keeps the same slot element (and no replayed grow-in) when the draft card becomes the reply card", () => {
    const { container, rerender } = renderSlot(
      <ThreadSlot
        activity={undefined}
        replyCount={0}
        threadHref={null}
        summary={undefined}
        workspaceId="ws_1"
        draft={{ draftId: "draft_1", preview: "typed but unsent", attachmentCount: 0, isCheckedOut: true }}
        draftHref="/panel/draft:stream_1:msg_1"
      />
    )
    const slotBeforeSend = container.firstChild
    expect(slotBeforeSend).not.toBeNull()

    // The send: the optimistic reply lands and the draft row is gone. Both sides
    // of the swap live in the same grid cell, so the slot is never unmounted.
    rerender(
      <MemoryRouter>
        <ThreadSlot
          activity={undefined}
          replyCount={1}
          threadHref="/panel/thread_1"
          summary={summary}
          workspaceId="ws_1"
          draft={null}
          draftHref="/panel/draft:stream_1:msg_1"
        />
      </MemoryRouter>
    )
    expect(container.firstChild).toBe(slotBeforeSend)
    expect(screen.getByText("1 reply")).toBeInTheDocument()
    expect(screen.queryByText("Draft")).toBeNull()
    expect(container.querySelector(".animate-thread-grow")).toBeNull()
  })

  it("applies the grow-in animation only on the first visible→true transition", () => {
    // On initial mount with visible=true (replies already exist when we first
    // see the component, e.g. a Virtuoso scroll-in), the useEffect's wasRef
    // matches the current value and animation does not fire.
    const { container } = renderSlot(
      <ThreadSlot activity={undefined} replyCount={2} threadHref="/thread/1" summary={summary} workspaceId="ws_1" />
    )
    expect(container.querySelector(".animate-thread-grow")).toBeNull()
  })
})
