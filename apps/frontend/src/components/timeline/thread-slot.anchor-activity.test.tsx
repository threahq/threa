import { beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ActiveAgentSession, ThreadSummary } from "@threahq/types"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as workspaceEmojiModule from "@/hooks/use-workspace-emoji"
import * as relativeTimeModule from "@/components/relative-time"
import { seedAgentActivity, __resetAgentActivityStore } from "@/stores/agent-activity-store"
import { ThreadSlot } from "./thread-slot"

const workspaceId = "ws_1"
const anchorId = "msg_anchor"
const streamId = "stream_parent"
const threadStreamId = "stream_thread"

const summary: ThreadSummary = {
  lastReplyAt: "2026-04-19T12:00:00.000Z",
  participants: [{ id: "user_alice", type: "user" }],
  latestReply: {
    messageId: "msg_reply",
    actorId: "user_alice",
    actorType: "user",
    contentMarkdown: "first reply",
  },
}

function session(overrides: Partial<ActiveAgentSession> = {}): ActiveAgentSession {
  return {
    sessionId: "session_1",
    streamId: threadStreamId,
    rootStreamId: streamId,
    parentAnchorId: anchorId,
    personaName: "Ariadne",
    startedAt: "2026-04-19T12:00:00.000Z",
    currentStepType: "workspace_search",
    stepCount: 1,
    messageCount: 0,
    substep: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  __resetAgentActivityStore()
  vi.spyOn(contextsModule, "useTrace").mockReturnValue({
    getTraceUrl: (id: string) => `/trace/${id}`,
  } as ReturnType<typeof contextsModule.useTrace>)
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

function renderSlot(props: Partial<React.ComponentProps<typeof ThreadSlot>> = {}) {
  return render(
    <MemoryRouter>
      <ThreadSlot
        anchorId={anchorId}
        streamId={streamId}
        replyCount={0}
        threadHref={null}
        summary={undefined}
        workspaceId={workspaceId}
        {...props}
      />
    </MemoryRouter>
  )
}

describe("ThreadSlot reads the anchor store", () => {
  it("paints a bootstrap-seeded session on first render, with no socket event", () => {
    seedAgentActivity(workspaceId, [session()])

    renderSlot()

    expect(screen.getByRole("link")).toHaveAttribute("aria-label", "Ariadne is searching workspace…")
  })

  it("keeps the session's row while the thread card shows its replies", () => {
    seedAgentActivity(workspaceId, [session()])

    const { container } = renderSlot({ replyCount: 2, threadHref: "/thread/1", summary })

    expect(screen.getByLabelText("Ariadne is searching workspace…")).toBeInTheDocument()
    expect(screen.getByText("2 replies")).toBeInTheDocument()
    // Both rows open. Presence in the DOM is not enough — the grid collapsing
    // the thinking row to `0fr` is exactly how the indicator used to vanish
    // once the card appeared.
    expect(container.querySelector<HTMLElement>("div.grid")?.style.gridTemplateRows).toBe("1fr 1fr")
  })

  it("leaves a session running in the anchor's own stream to its session card", () => {
    seedAgentActivity(workspaceId, [session({ streamId, parentAnchorId: null, triggerMessageId: anchorId })])

    const { container } = renderSlot()

    expect(container.firstChild).toBeNull()
  })

  it("shows the anchor's own in-stream session where session cards are hidden", () => {
    seedAgentActivity(workspaceId, [session({ streamId, parentAnchorId: null, triggerMessageId: anchorId })])

    renderSlot({ hideSessionCards: true })

    expect(screen.getByLabelText("Ariadne is searching workspace…")).toBeInTheDocument()
  })
})
