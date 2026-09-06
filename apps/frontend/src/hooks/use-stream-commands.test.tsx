import { describe, it, expect, beforeEach, vi } from "vitest"
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import type { CommandInfo } from "@threahq/types"
import { commandsApi } from "@/api"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { useStreamCommands, commandKeys } from "./use-stream-commands"

const workspaceCommand = { name: "invite", description: "Invite someone" } as unknown as CommandInfo
const runtimeCommand = { name: "steer", description: "Steer the agent" } as unknown as CommandInfo

let listForStream: ReturnType<typeof vi.spyOn>

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  listForStream = vi.spyOn(commandsApi, "listForStream").mockResolvedValue([])
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue({
    commands: [workspaceCommand],
  } as never)
})

describe("useStreamCommands", () => {
  it("never fetches for a draft stream id — the empty server list would replace the workspace palette", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useStreamCommands("ws_1", "draft_abc"), { wrapper: wrapper(queryClient) })

    await waitFor(() => expect(result.current).toEqual([workspaceCommand]))
    expect(listForStream).not.toHaveBeenCalled()
  })

  it("fetches for a real stream id", async () => {
    listForStream.mockResolvedValue([runtimeCommand])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useStreamCommands("ws_1", "stream_1"), { wrapper: wrapper(queryClient) })

    await waitFor(() => expect(result.current).toEqual([runtimeCommand]))
  })

  it("picks up a socket-driven refresh written onto the commands query key", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useStreamCommands("ws_1", "stream_1"), { wrapper: wrapper(queryClient) })
    await waitFor(() => expect(result.current).toEqual([workspaceCommand]))

    // What `refreshStreamCommands` (sync/stream-sync.ts) does when a runtime
    // comes online: the query path must see it, not just the bootstrap cache.
    queryClient.setQueryData(commandKeys.forStream("ws_1", "stream_1"), [runtimeCommand])

    await waitFor(() => expect(result.current).toEqual([runtimeCommand]))
  })
})
