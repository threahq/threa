import { beforeEach, describe, it, expect, vi } from "vitest"
import { act, render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ActiveAgentSession } from "@threahq/types"
import * as contextsModule from "@/contexts"
import { seedAgentActivity, updateAgentSessionProgress, resetAgentActivityStore } from "@/stores/agent-activity-store"
import { AgentActivityHeaderChip } from "./agent-activity-header-chip"

const workspaceId = "ws_1"
const streamId = "stream_parent"
const threadStreamId = "stream_thread"

function session(overrides: Partial<ActiveAgentSession> = {}): ActiveAgentSession {
  return {
    sessionId: "session_1",
    streamId,
    rootStreamId: streamId,
    parentAnchorId: null,
    personaName: "Ariadne",
    startedAt: "2026-04-19T12:00:00.000Z",
    currentStepType: "workspace_search",
    stepCount: 3,
    messageCount: 0,
    substep: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  resetAgentActivityStore()
  vi.spyOn(contextsModule, "useTrace").mockReturnValue({
    getTraceUrl: (id: string) => `/trace/${id}`,
  } as ReturnType<typeof contextsModule.useTrace>)
})

/**
 * The two headers that mount the chip: the stream page scopes it to the stream
 * it has open, the thread panel to the panel's own stream.
 */
function renderBothHeaders() {
  return render(
    <MemoryRouter>
      <div data-testid="stream-header">
        <AgentActivityHeaderChip workspaceId={workspaceId} streamId={streamId} />
      </div>
      <div data-testid="panel-header">
        <AgentActivityHeaderChip workspaceId={workspaceId} streamId={threadStreamId} />
      </div>
    </MemoryRouter>
  )
}

describe("AgentActivityHeaderChip", () => {
  it("lights the thread's own header and leaves the parent stream's header idle", () => {
    seedAgentActivity(workspaceId, [
      session({ streamId: threadStreamId, rootStreamId: streamId, parentAnchorId: "msg_anchor" }),
    ])

    renderBothHeaders()

    expect(within(screen.getByTestId("panel-header")).getByRole("link")).toHaveAttribute(
      "aria-label",
      "Ariadne is working — open agent trace"
    )
    expect(within(screen.getByTestId("stream-header")).queryByRole("link")).toBeNull()
  })

  it("lights the open stream's header with the persona name and live step count", () => {
    seedAgentActivity(workspaceId, [session()])

    renderBothHeaders()

    const chip = within(screen.getByTestId("stream-header")).getByRole("link")
    expect(chip).toHaveAttribute("href", "/trace/session_1")
    expect(chip).toHaveTextContent("Ariadne")
    expect(chip).toHaveTextContent("3 steps")
    expect(within(screen.getByTestId("panel-header")).queryByRole("link")).toBeNull()
  })

  it("renders the multi-session label when two sessions run in the same stream", () => {
    seedAgentActivity(workspaceId, [
      session(),
      session({ sessionId: "session_2", personaName: "Theseus", startedAt: "2026-04-19T12:05:00.000Z" }),
    ])

    renderBothHeaders()

    const chip = within(screen.getByTestId("stream-header")).getByRole("link")
    expect(chip).toHaveTextContent("2 agents working")
    // Most recently started is the click target.
    expect(chip).toHaveAttribute("href", "/trace/session_2")
  })

  it("follows a step tick without remounting the chip", () => {
    seedAgentActivity(workspaceId, [session({ stepCount: 1 })])

    renderBothHeaders()
    const chip = within(screen.getByTestId("stream-header")).getByRole("link")
    expect(chip).toHaveTextContent("1 step")

    act(() => updateAgentSessionProgress(workspaceId, "session_1", { stepCount: 4 }))

    expect(within(screen.getByTestId("stream-header")).getByRole("link")).toBe(chip)
    expect(chip).toHaveTextContent("4 steps")
  })

  it("lights up when a session starts after the header mounted", () => {
    renderBothHeaders()
    expect(within(screen.getByTestId("panel-header")).queryByRole("link")).toBeNull()

    act(() => seedAgentActivity(workspaceId, [session({ streamId: threadStreamId, parentAnchorId: "msg_anchor" })]))

    expect(within(screen.getByTestId("panel-header")).getByRole("link")).toHaveTextContent("Ariadne")
    expect(within(screen.getByTestId("stream-header")).queryByRole("link")).toBeNull()
  })

  it("clears when the session leaves the running set", () => {
    seedAgentActivity(workspaceId, [session()])
    renderBothHeaders()
    expect(within(screen.getByTestId("stream-header")).getByRole("link")).toBeInTheDocument()

    act(() => seedAgentActivity(workspaceId, []))

    expect(within(screen.getByTestId("stream-header")).queryByRole("link")).toBeNull()
  })
})
