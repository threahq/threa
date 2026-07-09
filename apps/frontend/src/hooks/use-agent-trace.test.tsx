import type { ReactNode } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Socket } from "socket.io-client"
import type { AgentSessionStep, AgentSessionWithSteps } from "@threa/types"
import * as contextsModule from "@/contexts"
import * as workspacesModule from "@/hooks/use-workspaces"
import * as socketRoomModule from "@/lib/socket-room"
import { agentSessionsApi } from "@/api"
import { useAgentTrace } from "./use-agent-trace"

const WORKSPACE_ID = "ws_1"
const SESSION_ID = "session_1"
const SESSION_ROOM = `ws:${WORKSPACE_ID}:agent_session:${SESSION_ID}`

type Handler = (payload: unknown) => void

/** Minimal socket stub that records listeners so tests can fire server events. */
function makeFakeSocket() {
  const handlers = new Map<string, Set<Handler>>()
  const socket = {
    connected: true,
    on: vi.fn((event: string, handler: Handler) => {
      let set = handlers.get(event)
      if (!set) {
        set = new Set()
        handlers.set(event, set)
      }
      set.add(handler)
      return socket
    }),
    off: vi.fn((event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler)
      return socket
    }),
    emit: vi.fn(),
  }
  const fire = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload)
  }
  return { socket: socket as unknown as Socket, fire }
}

function makeStep(stepNumber: number): AgentSessionStep {
  return {
    id: `step_${stepNumber}`,
    sessionId: SESSION_ID,
    stepNumber,
    stepType: "thinking",
    startedAt: "2026-07-09T10:00:00.000Z",
  }
}

function makeSessionResponse(steps: AgentSessionStep[]): AgentSessionWithSteps {
  return {
    session: {
      id: SESSION_ID,
      streamId: "stream_1",
      personaId: "persona_1",
      triggerMessageId: "msg_1",
      triggerMessageRevision: 1,
      supersedesSessionId: null,
      status: "running",
      sentMessageIds: [],
      createdAt: "2026-07-09T10:00:00.000Z",
    },
    steps,
    persona: { id: "persona_1", name: "Ariadne", avatarUrl: null },
    relatedSessions: [],
  }
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

let reconnectCount = 0

beforeEach(() => {
  vi.restoreAllMocks()
  reconnectCount = 0
  vi.spyOn(contextsModule, "useSocketReconnectCount").mockImplementation(() => reconnectCount)
  vi.spyOn(workspacesModule, "useWorkspaceUserId").mockReturnValue("member_1")
})

describe("useAgentTrace", () => {
  it("joins the session room, bootstraps, and applies realtime step events", async () => {
    const { socket, fire } = makeFakeSocket()
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(socket)
    const joinSpy = vi.spyOn(socketRoomModule, "joinRoomWithAck").mockResolvedValue(undefined)
    const getSessionSpy = vi.spyOn(agentSessionsApi, "getSession").mockResolvedValue(makeSessionResponse([makeStep(1)]))

    const { result } = renderHook(() => useAgentTrace(WORKSPACE_ID, SESSION_ID), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.steps).toHaveLength(1))
    expect(joinSpy).toHaveBeenCalledWith(socket, SESSION_ROOM, expect.anything())
    expect(getSessionSpy).toHaveBeenCalledTimes(1)

    act(() => {
      fire("agent_session:step:started", { sessionId: SESSION_ID, step: makeStep(2) })
    })
    expect(result.current.steps.map((s) => s.stepNumber)).toEqual([1, 2])
  })

  it("re-joins the session room and refetches bootstrap after a socket reconnect (INV-53)", async () => {
    const { socket, fire } = makeFakeSocket()
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(socket)
    const joinSpy = vi.spyOn(socketRoomModule, "joinRoomWithAck").mockResolvedValue(undefined)
    const getSessionSpy = vi
      .spyOn(agentSessionsApi, "getSession")
      .mockResolvedValueOnce(makeSessionResponse([makeStep(1)]))
      // Steps 2-3 landed while the socket was down; only a refetch can recover them.
      .mockResolvedValue(makeSessionResponse([makeStep(1), makeStep(2), makeStep(3)]))

    const { result, rerender } = renderHook(() => useAgentTrace(WORKSPACE_ID, SESSION_ID), {
      wrapper: createWrapper(),
    })
    await waitFor(() => expect(result.current.steps).toHaveLength(1))

    reconnectCount = 1
    rerender()

    await waitFor(() => expect(joinSpy).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(getSessionSpy).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.steps.map((s) => s.stepNumber)).toEqual([1, 2, 3]))

    // The re-armed subscription must keep receiving live events — including the
    // terminal one, which is what lets the dialog leave the "running" state.
    act(() => {
      fire("agent_session:completed", { sessionId: SESSION_ID })
    })
    expect(result.current.status).toBe("completed")
  })
})
