import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { commandsApi } from "@/api"
import { consumeComposerCommandRequest } from "@/stores/composer-command-request-store"
import { useSteerAgentSession } from "./use-steer-agent-session"

describe("useSteerAgentSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(commandsApi, "listForStream").mockResolvedValue([])
  })

  it("queues /steer for the stream when the external runtime advertises it", async () => {
    vi.mocked(commandsApi.listForStream).mockResolvedValue([
      { name: "steer", description: "Steer", kind: "bot-runtime", scope: "stream" },
    ])
    const { result } = renderHook(() => useSteerAgentSession("ws_1", "stream_1"))

    await act(() => result.current())

    expect(commandsApi.listForStream).toHaveBeenCalledWith("ws_1", "stream_1")
    expect(consumeComposerCommandRequest("stream_1")).toBe("/steer ")
  })

  it("leaves persona composers unchanged when no runtime steer command is advertised", async () => {
    const { result } = renderHook(() => useSteerAgentSession("ws_1", "stream_2"))

    await act(() => result.current())

    expect(commandsApi.listForStream).toHaveBeenCalled()
    expect(consumeComposerCommandRequest("stream_2")).toBeNull()
  })
})
