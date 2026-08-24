import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { PI_TOOL_TRACE_FORMAT, PiToolTraceSectionLabels, type AgentSessionStep } from "@threa/types"
import { TraceStepList } from "./trace-step-list"
import * as relativeTimeModule from "@/components/relative-time"
import { clearDecryptCache, seedDecryption } from "@/lib/crypto/decrypt-cache"

function toolUse(id: string, stepNumber: number, headline: string): AgentSessionStep {
  return createStep({
    id,
    stepNumber,
    content: JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline,
      sections: [{ label: PiToolTraceSectionLabels.ARGUMENTS, body: "Arguments omitted for safety.", lang: null }],
    }),
  })
}

function toolResult(id: string, stepNumber: number, headline: string): AgentSessionStep {
  return createStep({
    id,
    stepNumber,
    content: JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline,
      sections: [{ label: PiToolTraceSectionLabels.OUTPUT, body: "Tool output omitted for safety.", lang: null }],
    }),
  })
}

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
    clearDecryptCache()
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
    expect(screen.getAllByRole("button", { name: /tool activity/i })).toHaveLength(2)
    expect(screen.queryByText(/0 errors/)).not.toBeInTheDocument()
  })

  it("previews the latest tool in the active phase and summarises settled phases as rows", () => {
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

    expect(screen.getAllByText("Tool activity")).toHaveLength(2)
    expect(screen.getByText("In progress")).toBeInTheDocument()
    expect(screen.getByText("Run current test")).toBeInTheDocument()
    expect(screen.getByText("latest preview")).toBeInTheDocument()
    // The settled phase keeps its headline in the summary, but never a stale preview body.
    expect(screen.getByText("Read old file")).toBeInTheDocument()
    expect(screen.queryByText("old preview")).not.toBeInTheDocument()
  })

  it("keeps later tool runs nested under the same thinking phase across incidental rows", () => {
    renderList([
      thinking("think_1", 1, "Plan"),
      createStep({ id: "tool_1", stepNumber: 2 }),
      createStep({ id: "reply_1", stepNumber: 3, stepType: "message_sent", content: "Interim" }),
      createStep({ id: "tool_2", stepNumber: 4 }),
    ])

    expect(screen.getAllByText("Tool activity")).toHaveLength(1)
    expect(screen.getByText("2 tool calls")).toBeInTheDocument()
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
    expect(screen.queryByText("first output line")).not.toBeInTheDocument()
  })

  it("removes the latest-step preview when the session completes", () => {
    renderList([
      thinking("think_1", 1, "Plan"),
      createStep({ id: "tool_1", stepNumber: 2 }),
      createStep({ id: "tool_2", stepNumber: 3 }),
    ])

    expect(screen.getByText("Tool activity")).toBeInTheDocument()
    expect(screen.getByText("Finished")).toBeInTheDocument()
    expect(screen.queryByText("first output line")).not.toBeInTheDocument()
  })

  it("opens an existing phase when a live tool error arrives", () => {
    const initial = [thinking("think_1", 1, "Plan"), createStep({ id: "tool_1", stepNumber: 2 })]
    const view = renderList(initial, true)

    expect(screen.getByRole("button", { name: /tool activity/i })).toHaveAttribute("aria-expanded", "false")

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

  it("opens full details when an existing grouped tool step becomes highlighted", () => {
    const steps = [thinking("think_1", 1, "Plan"), createStep({ id: "tool_1", stepNumber: 2, messageId: "msg_tool" })]
    const view = renderList(steps)

    expect(screen.getByRole("button", { name: /tool activity/i })).toHaveAttribute("aria-expanded", "false")

    view.rerender(listElement(steps, false, "msg_tool"))

    expect(screen.getByRole("button", { name: /tool activity/i })).toHaveAttribute("aria-expanded", "true")
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

    await user.click(screen.getByRole("button", { name: /tool activity/i }))
    expect(screen.queryByText("boom stack")).not.toBeInTheDocument()
  })

  it("groups bot tools without thinking under a plain tool activity section", () => {
    renderList([createStep({ id: "tool_1", stepNumber: 1 }), createStep({ id: "tool_2", stepNumber: 2 })])

    expect(screen.getByText("Tool activity")).toBeInTheDocument()
    expect(screen.getByText("2 tool calls")).toBeInTheDocument()
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument()
  })

  it("counts paired use/result steps as one call each and spells out repeated calls", () => {
    renderList([
      toolUse("use_1", 1, "Running shell command"),
      toolResult("res_1", 2, "Running shell command"),
      toolUse("use_2", 3, "Running shell command"),
      toolResult("res_2", 4, "Running shell command"),
    ])

    expect(screen.getByText("2 tool calls")).toBeInTheDocument()
    const summary = screen.getByRole("listitem", { name: /Running shell command/ })
    expect(summary).toHaveTextContent("Running shell command")
    expect(summary).toHaveTextContent("2 calls")
    expect(summary).toHaveTextContent("Complete")
    expect(summary).toHaveAccessibleName("Running shell command, 2 calls, Complete")
    expect(summary).not.toHaveTextContent("×")
  })

  it("keeps distinct tools as their own rows within a mixed run", () => {
    renderList([
      toolUse("use_1", 1, "Running shell command"),
      toolResult("res_1", 2, "Running shell command"),
      toolUse("use_2", 3, "Running shell command"),
      toolResult("res_2", 4, "Running shell command"),
      toolUse("use_3", 5, "Reading file src/app.ts"),
      toolResult("res_3", 6, "Reading file src/app.ts"),
    ])

    expect(screen.getByText("3 tool calls")).toBeInTheDocument()
    expect(screen.getByRole("listitem", { name: /Running shell command/ })).toHaveTextContent("2 calls")
    expect(screen.getByRole("listitem", { name: /Reading file src\/app\.ts/ })).toHaveTextContent("Complete")
  })

  it("says one call and drops the repeat suffix for a single tool call", () => {
    renderList([toolUse("use_1", 1, "Running shell command"), toolResult("res_1", 2, "Running shell command")])

    expect(screen.getByText("1 tool call")).toBeInTheDocument()
    expect(screen.getByText("Running shell command")).toBeInTheDocument()
  })

  it("shows the overflow affordance over deduped summaries, not steps", () => {
    const steps = ["alpha", "alpha", "bravo", "charlie", "delta"].flatMap((name, index) => [
      toolUse(`use_${index}`, index * 2 + 1, `Running ${name}`),
      toolResult(`res_${index}`, index * 2 + 2, `Running ${name}`),
    ])
    renderList(steps)

    expect(screen.getByText("5 tool calls")).toBeInTheDocument()
    expect(screen.getByRole("listitem", { name: /Running alpha/ })).toHaveTextContent("2 calls")
    // 4 deduped summaries, 3 shown → one hidden, even though 10 steps went in.
    expect(screen.getByText("1 more call")).toBeInTheDocument()
  })

  it("counts a parallel batch of the same tool as one call per use", () => {
    renderList([
      toolUse("use_1", 1, "Running shell command"),
      toolUse("use_2", 2, "Running shell command"),
      toolResult("res_1", 3, "Running shell command"),
      toolResult("res_2", 4, "Running shell command"),
    ])

    expect(screen.getByText("2 tool calls")).toBeInTheDocument()
    expect(screen.getByRole("listitem", { name: /Running shell command/ })).toHaveTextContent("2 calls")
  })

  it("counts a parallel batch whose results come back out of order", () => {
    renderList([
      toolUse("use_1", 1, "Running shell command"),
      toolUse("use_2", 2, "Reading file src/app.ts"),
      toolResult("res_2", 3, "Reading file src/app.ts"),
      toolResult("res_1", 4, "Running shell command"),
    ])

    expect(screen.getByText("2 tool calls")).toBeInTheDocument()
  })

  it("keeps a mixed parallel batch as one row per distinct tool", () => {
    renderList([
      toolUse("use_1", 1, "Running shell command"),
      toolUse("use_2", 2, "Reading file src/app.ts"),
      toolResult("res_1", 3, "Running shell command"),
      toolResult("res_2", 4, "Reading file src/app.ts"),
    ])

    expect(screen.getByText("2 tool calls")).toBeInTheDocument()
    expect(screen.getByText("Running shell command")).toBeInTheDocument()
    expect(screen.getByText("Reading file src/app.ts")).toBeInTheDocument()
  })

  it("binds a result whose headline degraded to the open call instead of fabricating one", () => {
    renderList([toolUse("use_1", 1, "Running shell command"), toolResult("res_1", 2, "Used bash")])

    expect(screen.getByText("1 tool call")).toBeInTheDocument()
    expect(screen.getByText("Running shell command")).toBeInTheDocument()
    expect(screen.queryByText("Used bash")).not.toBeInTheDocument()
  })

  it("groups and summarizes sealed steps from the decrypt cache", () => {
    const sealedContent = (headline: string, label: string) =>
      JSON.stringify({ format: PI_TOOL_TRACE_FORMAT, headline, sections: [{ label, body: "sealed", lang: null }] })
    seedDecryption("sealed_use", {
      contentMarkdown: sealedContent("Running shell command", PiToolTraceSectionLabels.ARGUMENTS),
      contentJson: { type: "doc", content: [] },
    })
    seedDecryption("sealed_result", {
      contentMarkdown: sealedContent("Running shell command", PiToolTraceSectionLabels.OUTPUT),
      contentJson: { type: "doc", content: [] },
    })

    renderList([
      createStep({ id: "sealed_use", stepNumber: 1, content: undefined }),
      createStep({ id: "sealed_result", stepNumber: 2, content: undefined }),
    ])

    expect(screen.getByText("1 tool call")).toBeInTheDocument()
    expect(screen.getByText("Running shell command")).toBeInTheDocument()
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
