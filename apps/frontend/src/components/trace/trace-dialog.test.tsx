import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { AgentSession } from "@threa/types"
import { TraceDialog } from "./trace-dialog"
import * as contextsModule from "@/contexts"
import * as useAgentTraceModule from "@/hooks/use-agent-trace"
import * as workspacesModule from "@/hooks/use-workspaces"
import * as relativeTimeModule from "@/components/relative-time"
import * as hooksModule from "@/hooks"
import { commandsApi } from "@/api"
import { toast } from "sonner"
import { consumeComposerCommandRequest } from "@/stores/composer-command-request-store"

let mockSessionId = "session_1"
let mockSessionIndex = 0
let mockSteps: unknown[] = []
let mockSession: AgentSession
let mockRelatedSessions: AgentSession[]

const relatedSessions: AgentSession[] = [
  {
    id: "session_1",
    streamId: "stream_1",
    personaId: "persona_1",
    triggerMessageId: "msg_1",
    triggerMessageRevision: 1,
    supersedesSessionId: null,
    status: "superseded",
    sentMessageIds: ["msg_a"],
    createdAt: "2026-02-19T10:00:00.000Z",
    completedAt: "2026-02-19T10:01:00.000Z",
  },
  {
    id: "session_2",
    streamId: "stream_1",
    personaId: "persona_1",
    triggerMessageId: "msg_1",
    triggerMessageRevision: 2,
    supersedesSessionId: "session_1",
    rerunContext: {
      cause: "referenced_message_edited",
      editedMessageId: "msg_follow_up_1",
      editedMessageBefore: "Include peanut butter",
      editedMessageAfter: "No peanuts please",
    },
    status: "completed",
    sentMessageIds: ["msg_a"],
    createdAt: "2026-02-19T10:02:00.000Z",
    completedAt: "2026-02-19T10:03:00.000Z",
  },
]

function renderTrace(extra?: ReactNode) {
  return render(
    <div data-editor-zone="main">
      <MemoryRouter initialEntries={["/w/ws_1"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<TraceDialog />} />
        </Routes>
      </MemoryRouter>
      {extra}
    </div>
  )
}

describe("TraceDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockSessionId = "session_1"
    mockSessionIndex = 0
    mockSteps = []
    mockSession = relatedSessions[0]!
    mockRelatedSessions = relatedSessions

    vi.spyOn(contextsModule, "useTrace").mockImplementation((() => ({
      sessionId: mockSessionId,
      highlightMessageId: null,
      getTraceUrl: (id: string) => `/trace/${id}`,
      closeTraceModal: vi.fn(),
    })) as unknown as typeof contextsModule.useTrace)

    vi.spyOn(useAgentTraceModule, "useAgentTrace").mockImplementation((() => ({
      steps: mockSteps,
      session: mockSession,
      relatedSessions: mockRelatedSessions,
      persona: { id: "persona_1", name: "Ariadne", avatarUrl: null, avatarEmoji: "🜃" },
      status: mockSession.status,
      isLoading: false,
      error: null,
    })) as unknown as typeof useAgentTraceModule.useAgentTrace)

    vi.spyOn(commandsApi, "listForStream").mockResolvedValue([])
    vi.spyOn(commandsApi, "dispatch").mockResolvedValue({
      success: true,
      commandId: "cmd_1",
      command: "stop",
      args: "",
      event: {
        id: "event_1",
        streamId: "stream_1",
        sequence: "1",
        eventType: "command_dispatched",
        payload: {},
        actorId: "member_1",
        actorType: "user",
        createdAt: "2026-07-05T00:00:00.000Z",
      },
    })
    vi.spyOn(toast, "error").mockReturnValue("" as ReturnType<typeof toast.error>)

    vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation((() => (
      <span>just now</span>
    )) as unknown as typeof relativeTimeModule.RelativeTime)

    // TraceDialog resolves the viewer id (for decrypting sealed enclave steps);
    // stub it so the dialog doesn't reach for the real auth context.
    vi.spyOn(workspacesModule, "useWorkspaceUserId").mockReturnValue("member_1")
  })

  it("shows superseded-by version hint for superseded sessions", () => {
    mockSessionId = "session_1"
    mockSessionIndex = 0
    mockSession = relatedSessions[mockSessionIndex]!
    mockRelatedSessions = relatedSessions
    mockSteps = []
    renderTrace()

    expect(screen.getByText("Superseded by Version 2")).toBeInTheDocument()
  })

  it("shows rerun reason when session was retriggered by follow-up edit", () => {
    mockSessionId = "session_2"
    mockSessionIndex = 1
    mockSession = relatedSessions[mockSessionIndex]!
    mockRelatedSessions = relatedSessions
    mockSteps = []
    renderTrace()

    expect(screen.getByText("Rerun triggered by follow-up message edit")).toBeInTheDocument()
    expect(
      screen.getByText('Edited message changed from "Include peanut butter" to "No peanuts please"')
    ).toBeInTheDocument()
  })

  it("counts message edits as sent responses in footer", () => {
    mockSessionId = "session_2"
    mockSessionIndex = 1
    mockSession = relatedSessions[mockSessionIndex]!
    mockRelatedSessions = relatedSessions
    mockSteps = [
      { id: "step_1", stepType: "thinking" },
      { id: "step_2", stepType: "message_edited" },
      { id: "step_3", stepType: "reconsidering" },
    ]

    renderTrace()

    expect(screen.getByText("3 steps • 1 message sent")).toBeInTheDocument()
  })

  it("keeps Redirect visible for regular running agents and focuses the composer", async () => {
    const focusAtEnd = vi.spyOn(hooksModule, "focusAtEnd").mockImplementation(() => undefined)
    mockSessionId = "session_run"
    mockSession = {
      id: "session_run",
      streamId: "stream_1",
      personaId: "persona_1",
      triggerMessageId: "msg_1",
      status: "running",
      sentMessageIds: [],
      createdAt: "2026-02-19T10:00:00.000Z",
    }
    mockRelatedSessions = [mockSession]
    mockSteps = [
      {
        id: "step_running",
        sessionId: "session_run",
        stepNumber: 1,
        stepType: "thinking",
        startedAt: "2026-02-19T10:00:01.000Z",
      },
    ]

    renderTrace(<div data-testid="zone-editor" contentEditable />)

    const zoneEditor = screen.getByTestId("zone-editor")
    const rects = {
      length: 1,
      item: (index: number) => (index === 0 ? ({ width: 1, height: 1 } as DOMRect) : null),
      0: { width: 1, height: 1 } as DOMRect,
    } as unknown as DOMRectList
    vi.spyOn(zoneEditor, "getClientRects").mockReturnValue(rects)

    fireEvent.click(screen.getByRole("button", { name: "Redirect" }))

    await waitFor(() => expect(focusAtEnd).toHaveBeenCalledWith(zoneEditor))
    expect(commandsApi.dispatch).not.toHaveBeenCalled()
  })

  it("does not re-fetch runtime commands on Stop after an empty command list is loaded", async () => {
    mockSessionId = "session_run"
    mockSession = {
      id: "session_run",
      streamId: "stream_1",
      personaId: "persona_1",
      triggerMessageId: "msg_1",
      status: "running",
      sentMessageIds: [],
      createdAt: "2026-02-19T10:00:00.000Z",
    }
    mockRelatedSessions = [mockSession]
    mockSteps = [
      {
        id: "step_running",
        sessionId: "session_run",
        stepNumber: 1,
        stepType: "thinking",
        startedAt: "2026-02-19T10:00:01.000Z",
      },
    ]

    renderTrace()

    await waitFor(() => expect(commandsApi.listForStream).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole("button", { name: "Stop" }))

    expect(commandsApi.listForStream).toHaveBeenCalledTimes(1)
    expect(commandsApi.dispatch).not.toHaveBeenCalled()
  })

  it("dispatches runtime stop and prepares the composer with advertised /steer", async () => {
    mockSessionId = "session_run"
    mockSession = {
      id: "session_run",
      streamId: "stream_1",
      personaId: "bot_1",
      triggerMessageId: "msg_1",
      status: "running",
      sentMessageIds: [],
      createdAt: "2026-02-19T10:00:00.000Z",
    }
    mockRelatedSessions = [mockSession]
    mockSteps = [
      {
        id: "step_running",
        sessionId: "session_run",
        stepNumber: 1,
        stepType: "thinking",
        startedAt: "2026-02-19T10:00:01.000Z",
      },
    ]
    vi.mocked(commandsApi.listForStream).mockResolvedValue([
      { name: "steer", description: "Steer", kind: "bot-runtime", scope: "stream" },
      { name: "stop", description: "Stop", kind: "bot-runtime", scope: "stream" },
    ])

    renderTrace()

    await waitFor(() => expect(screen.getByRole("button", { name: "Redirect" })).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "Redirect" }))
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))

    await waitFor(() => expect(consumeComposerCommandRequest("stream_1")).toBe("/steer "))
    await waitFor(() =>
      expect(commandsApi.dispatch).toHaveBeenCalledWith("ws_1", { streamId: "stream_1", command: "/stop" })
    )
  })

  it("falls back to local Stop and surfaces a toast when advertised runtime stop fails", async () => {
    const abortSession = vi.fn()
    vi.spyOn(hooksModule, "useAbortSession").mockReturnValue(abortSession)
    mockSessionId = "session_run"
    mockSession = {
      id: "session_run",
      streamId: "stream_1",
      personaId: "bot_1",
      triggerMessageId: "msg_1",
      status: "running",
      sentMessageIds: [],
      createdAt: "2026-02-19T10:00:00.000Z",
    }
    mockRelatedSessions = [mockSession]
    mockSteps = [
      {
        id: "step_running",
        sessionId: "session_run",
        stepNumber: 1,
        stepType: "thinking",
        startedAt: "2026-02-19T10:00:01.000Z",
      },
    ]
    vi.mocked(commandsApi.listForStream).mockResolvedValue([
      { name: "stop", description: "Stop", kind: "bot-runtime", scope: "stream" },
    ])
    vi.mocked(commandsApi.dispatch).mockRejectedValue(new Error("network down"))

    renderTrace()

    await waitFor(() => expect(commandsApi.listForStream).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))

    await waitFor(() => expect(abortSession).toHaveBeenCalledWith({ sessionId: "session_run", workspaceId: "ws_1" }))
    expect(toast.error).toHaveBeenCalledWith("Runtime stop failed — using local stop instead")
  })
})
