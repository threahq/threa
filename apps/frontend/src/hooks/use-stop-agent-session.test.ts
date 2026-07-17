import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { Socket } from "socket.io-client"
import { commandsApi } from "@/api"
import { toast } from "sonner"
import { useStopAgentSession } from "./use-stop-agent-session"

function makeSocket() {
  return { emit: vi.fn() } as unknown as Socket
}

describe("useStopAgentSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(commandsApi, "listForStream").mockResolvedValue([])
    vi.spyOn(commandsApi, "dispatch").mockResolvedValue({} as Awaited<ReturnType<typeof commandsApi.dispatch>>)
    vi.spyOn(toast, "error").mockReturnValue("" as ReturnType<typeof toast.error>)
  })

  it("dispatches /stop when the stream advertises the external runtime command", async () => {
    const socket = makeSocket()
    vi.mocked(commandsApi.listForStream).mockResolvedValue([
      { name: "stop", description: "Stop", kind: "bot-runtime", scope: "stream" },
    ])
    const { result } = renderHook(() => useStopAgentSession(socket, "ws_1", "stream_1"))

    act(() => result.current("session_1"))

    await waitFor(() =>
      expect(commandsApi.dispatch).toHaveBeenCalledWith("ws_1", { streamId: "stream_1", command: "/stop" })
    )
    expect(socket.emit).not.toHaveBeenCalled()
  })

  it("uses the local session abort when no runtime stop command is advertised", async () => {
    const socket = makeSocket()
    const { result } = renderHook(() => useStopAgentSession(socket, "ws_1", "stream_1"))

    act(() => result.current("session_1"))

    await waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        "agent_session:research:abort",
        { sessionId: "session_1", workspaceId: "ws_1" },
        expect.any(Function)
      )
    )
    expect(commandsApi.dispatch).not.toHaveBeenCalled()
  })

  it("falls back to local abort when runtime dispatch fails", async () => {
    const socket = makeSocket()
    vi.mocked(commandsApi.listForStream).mockResolvedValue([
      { name: "stop", description: "Stop", kind: "bot-runtime", scope: "stream" },
    ])
    vi.mocked(commandsApi.dispatch).mockRejectedValue(new Error("network down"))
    const { result } = renderHook(() => useStopAgentSession(socket, "ws_1", "stream_1"))

    act(() => result.current("session_1"))

    await waitFor(() => expect(socket.emit).toHaveBeenCalled())
    expect(toast.error).toHaveBeenCalledWith("Runtime stop failed — using local stop instead")
  })
})
