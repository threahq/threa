import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { AgentSession } from "@threa/types"
import { TraceDialog } from "./trace-dialog"
import * as contextsModule from "@/contexts"
import * as useAgentTraceModule from "@/hooks/use-agent-trace"
import * as workspacesModule from "@/hooks/use-workspaces"
import * as relativeTimeModule from "@/components/relative-time"

let mockSessionId = "session_1"
let mockSessionIndex = 0
let mockSteps: Array<{ id: string; stepType: string }> = []

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

function renderTrace() {
  return render(
    <MemoryRouter initialEntries={["/w/ws_1"]}>
      <Routes>
        <Route path="/w/:workspaceId" element={<TraceDialog />} />
      </Routes>
    </MemoryRouter>
  )
}

describe("TraceDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks()

    vi.spyOn(contextsModule, "useTrace").mockImplementation((() => ({
      sessionId: mockSessionId,
      highlightMessageId: null,
      getTraceUrl: (id: string) => `/trace/${id}`,
      closeTraceModal: vi.fn(),
    })) as unknown as typeof contextsModule.useTrace)

    vi.spyOn(useAgentTraceModule, "useAgentTrace").mockImplementation((() => ({
      steps: mockSteps,
      session: relatedSessions[mockSessionIndex],
      relatedSessions,
      persona: { id: "persona_1", name: "Ariadne", avatarUrl: null, avatarEmoji: "🜃" },
      status: relatedSessions[mockSessionIndex].status,
      isLoading: false,
      error: null,
    })) as unknown as typeof useAgentTraceModule.useAgentTrace)

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
    mockSteps = []
    renderTrace()

    expect(screen.getByText("Superseded by Version 2")).toBeInTheDocument()
  })

  it("shows rerun reason when session was retriggered by follow-up edit", () => {
    mockSessionId = "session_2"
    mockSessionIndex = 1
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
    mockSteps = [
      { id: "step_1", stepType: "thinking" },
      { id: "step_2", stepType: "message_edited" },
      { id: "step_3", stepType: "reconsidering" },
    ]

    renderTrace()

    expect(screen.getByText("3 steps • 1 message sent")).toBeInTheDocument()
  })
})
