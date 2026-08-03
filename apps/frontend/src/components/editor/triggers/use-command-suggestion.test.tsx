import { describe, it, expect, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { ReactNode } from "react"
import type { CommandInfo } from "@threa/types"
import { spyOnExport } from "@/test"
import * as streamCommandsModule from "@/hooks/use-stream-commands"
import { useCommandSuggestion } from "./use-command-suggestion"

const WORKSPACE_COMMANDS: CommandInfo[] = [{ name: "invite", description: "Invite someone" }]
const HOST_STREAM_COMMANDS: CommandInfo[] = [{ name: "host-only", description: "Host route runtime command" }]
const CONVERSATION_COMMANDS: CommandInfo[] = [{ name: "compact", description: "Compact the session" }]

let requestedStreamIds: Array<string | undefined>
let requestedWorkspaceIds: Array<string | undefined>

beforeEach(() => {
  requestedStreamIds = []
  requestedWorkspaceIds = []
  spyOnExport(streamCommandsModule, "useStreamCommands").mockReturnValue(((
    workspaceId: string | undefined,
    streamId: string | undefined
  ) => {
    requestedWorkspaceIds.push(workspaceId)
    requestedStreamIds.push(streamId)
    if (streamId === "stream_host") return HOST_STREAM_COMMANDS
    if (streamId === "stream_conversation") return CONVERSATION_COMMANDS
    return WORKSPACE_COMMANDS
  }) as never)
})

function wrapper(path: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/w/:workspaceId" element={children} />
          <Route path="/w/:workspaceId/s/:streamId" element={children} />
        </Routes>
      </MemoryRouter>
    )
  }
}

function renderPalette(path: string, commandStreamId?: string | null) {
  return renderHook(() => useCommandSuggestion(commandStreamId === undefined ? {} : { commandStreamId }), {
    wrapper: wrapper(path),
  })
}

describe("useCommandSuggestion command scoping", () => {
  it("falls back to the route's stream when no commandStreamId is supplied", () => {
    const { result } = renderPalette("/w/ws_1/s/stream_host")
    expect(requestedStreamIds).toContain("stream_host")
    expect(result.current.isKnownCommand("host-only")).toBe(true)
  })

  it("uses the supplied conversation stream and never the host route's", () => {
    const { result } = renderPalette("/w/ws_1/s/stream_host", "stream_conversation")
    expect(requestedStreamIds).not.toContain("stream_host")
    expect({
      conversationCommand: result.current.isKnownCommand("compact"),
      hostCommand: result.current.isKnownCommand("host-only"),
    }).toEqual({ conversationCommand: true, hostCommand: false })
  })

  it("treats an unresolved conversation stream (null) as a scoping claim, not a route fallback", () => {
    const { result } = renderPalette("/w/ws_1/s/stream_host", null)
    expect(requestedStreamIds).toEqual([undefined])
    expect({
      workspaceCommand: result.current.isKnownCommand("invite"),
      hostCommand: result.current.isKnownCommand("host-only"),
    }).toEqual({ workspaceCommand: true, hostCommand: false })
  })

  it("offers workspace commands on a route with no stream", () => {
    const { result } = renderPalette("/w/ws_1")
    expect(result.current.isKnownCommand("invite")).toBe(true)
  })

  it("resolves commands against the route's workspace", () => {
    renderPalette("/w/ws_1/s/stream_host", "stream_conversation")
    expect(requestedWorkspaceIds).toEqual(["ws_1"])
  })
})
