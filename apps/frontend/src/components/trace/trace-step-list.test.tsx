import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { PI_TOOL_TRACE_FORMAT, PiToolTraceSectionLabels, type AgentSessionStep } from "@threa/types"
import { TraceStepList } from "./trace-step-list"
import * as relativeTimeModule from "@/components/relative-time"

function createStep(overrides: Partial<AgentSessionStep> = {}): AgentSessionStep {
  return {
    id: "step_1",
    sessionId: "session_1",
    stepNumber: 1,
    stepType: "tool_call",
    content: JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: "Run bash",
      sections: [{ label: PiToolTraceSectionLabels.OUTPUT, body: "first output line", lang: null }],
    }),
    startedAt: "2026-02-19T18:00:00.000Z",
    completedAt: "2026-02-19T18:00:01.000Z",
    ...overrides,
  }
}

function thinking(id: string, stepNumber: number, content: string): AgentSessionStep {
  return createStep({ id, stepNumber, stepType: "thinking", content })
}

function listElement(steps: AgentSessionStep[], isSessionRunning = false, highlightMessageId: string | null = null) {
  return (
    <MemoryRouter>
      <TraceStepList
        steps={steps}
        highlightMessageId={highlightMessageId}
        workspaceId="ws_1"
        streamId="stream_1"
        isSessionRunning={isSessionRunning}
      />
    </MemoryRouter>
  )
}

function renderList(steps: AgentSessionStep[], isSessionRunning = false, highlightMessageId: string | null = null) {
  return render(listElement(steps, isSessionRunning, highlightMessageId))
}

describe("TraceStepList", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation((() => (
      <span>just now</span>
    )) as unknown as typeof relativeTimeModule.RelativeTime)
  })

  it("keeps thinking top-level and groups each following run of bot tools beneath it", () => {
    renderList([
      thinking("think_1", 1, "First plan"),
      createStep({ id: "tool_1", stepNumber: 2 }),
      createStep({ id: "tool_2", stepNumber: 3 }),
      thinking("think_2", 4, "Revised plan"),
      createStep({ id: "tool_3", stepNumber: 5 }),
    ])

    expect(screen.getByText("First plan")).toBeInTheDocument()
    expect(screen.getByText("Revised plan")).toBeInTheDocument()
    expect(screen.getByText("2 tool calls")).toBeInTheDocument()
    expect(screen.getByText("1 tool call")).toBeInTheDocument()
    expect(screen.getAllByText("Full tool details")).toHaveLength(2)
    expect(screen.queryByText(/0 errors/)).not.toBeInTheDocument()
  })

  it("previews only the latest tool in the active thinking phase", () => {
    renderList(
      [
        thinking("think_1", 1, "First plan"),
        createStep({
          id: "tool_1",
          stepNumber: 2,
          content: JSON.stringify({
            format: PI_TOOL_TRACE_FORMAT,
            headline: "Read old file",
            sections: [{ label: PiToolTraceSectionLabels.OUTPUT, body: "old preview", lang: null }],
          }),
        }),
        thinking("think_2", 3, "Next plan"),
        createStep({
          id: "tool_2",
          stepNumber: 4,
          content: JSON.stringify({
            format: PI_TOOL_TRACE_FORMAT,
            headline: "Run current test",
            sections: [{ label: PiToolTraceSectionLabels.OUTPUT, body: "latest preview", lang: null }],
          }),
        }),
        createStep({ id: "reply_1", stepNumber: 5, stepType: "message_sent", content: "Done" }),
      ],
      true
    )

    expect(screen.getAllByText("Working")).toHaveLength(2)
    expect(screen.getByText("Run current test")).toBeInTheDocument()
    expect(screen.getByText("latest preview")).toBeInTheDocument()
    expect(screen.queryByText("Read old file")).not.toBeInTheDocument()
    expect(screen.queryByText("old preview")).not.toBeInTheDocument()
  })

  it("previews a truncated latest tool without exposing malformed content", () => {
    renderList(
      [
        thinking("think_1", 1, "Plan"),
        createStep({
          id: "tool_1",
          stepNumber: 2,
          content: `{"format":"${PI_TOOL_TRACE_FORMAT}","headline":"Run command","sections":[`,
        }),
      ],
      true
    )

    expect(screen.getByText("Tool trace was truncated")).toBeInTheDocument()
  })

  it("removes the previous preview when a new thinking header starts", () => {
    renderList(
      [
        thinking("think_1", 1, "First plan"),
        createStep({ id: "tool_1", stepNumber: 2 }),
        thinking("think_2", 3, "New plan"),
      ],
      true
    )

    expect(screen.getByText("New plan")).toBeInTheDocument()
    expect(screen.queryByText("Run bash")).not.toBeInTheDocument()
    expect(screen.queryByText("first output line")).not.toBeInTheDocument()
  })

  it("removes the latest-step preview when the session completes", () => {
    renderList([
      thinking("think_1", 1, "Plan"),
      createStep({ id: "tool_1", stepNumber: 2 }),
      createStep({ id: "tool_2", stepNumber: 3 }),
    ])

    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.queryByText("Run bash")).not.toBeInTheDocument()
    expect(screen.queryByText("first output line")).not.toBeInTheDocument()
  })

  it("opens an existing phase when a live tool error arrives", () => {
    const initial = [thinking("think_1", 1, "Plan"), createStep({ id: "tool_1", stepNumber: 2 })]
    const view = renderList(initial, true)

    expect(screen.getByRole("button", { name: /full tool details/i })).toHaveAttribute("aria-expanded", "false")

    view.rerender(
      listElement(
        [
          ...initial,
          createStep({
            id: "tool_2",
            stepNumber: 3,
            stepType: "tool_error",
            content: JSON.stringify({
              format: PI_TOOL_TRACE_FORMAT,
              headline: "Run bash",
              sections: [{ label: PiToolTraceSectionLabels.ERROR_OUTPUT, body: "live boom", lang: null }],
            }),
          }),
        ],
        true
      )
    )

    expect(screen.getAllByText("live boom")).toHaveLength(2)
  })

  it("opens full details when a grouped tool step is highlighted", () => {
    renderList(
      [thinking("think_1", 1, "Plan"), createStep({ id: "tool_1", stepNumber: 2, messageId: "msg_tool" })],
      false,
      "msg_tool"
    )

    expect(screen.getByRole("button", { name: /full tool details/i })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Run bash")).toBeInTheDocument()
  })

  it("shows error counts, opens error groups, and preserves full tool detail", async () => {
    const user = userEvent.setup()
    renderList([
      thinking("think_1", 1, "Plan"),
      createStep({ id: "tool_1", stepNumber: 2 }),
      createStep({
        id: "tool_2",
        stepNumber: 3,
        stepType: "tool_error",
        content: JSON.stringify({
          format: PI_TOOL_TRACE_FORMAT,
          headline: "Run bash",
          sections: [{ label: PiToolTraceSectionLabels.ERROR_OUTPUT, body: "boom stack", lang: null }],
        }),
      }),
    ])

    expect(screen.getByText(/1 error/)).toBeInTheDocument()
    expect(screen.getByText("boom stack")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /full tool details/i }))
    expect(screen.queryByText("boom stack")).not.toBeInTheDocument()
  })

  it("groups bot tools without thinking under a bare Working section", () => {
    renderList([createStep({ id: "tool_1", stepNumber: 1 }), createStep({ id: "tool_2", stepNumber: 2 })])

    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.getByText("2 tool calls")).toBeInTheDocument()
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument()
  })

  it("leaves non-bot tool steps as regular trace rows", () => {
    renderList([
      createStep({
        content: JSON.stringify({ tool: "workspace_search", args: { query: "pricing", format: PI_TOOL_TRACE_FORMAT } }),
      }),
    ])

    expect(screen.queryByText("Full tool details")).not.toBeInTheDocument()
    expect(screen.getByText("workspace_search")).toBeInTheDocument()
  })
})
