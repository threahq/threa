import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { ServicesProvider, type StreamService } from "@/contexts"
import { streamKeys } from "@/hooks/use-streams"
import { SharedWithBadge } from "./shared-with-badge"

const WORKSPACE_ID = "ws_1"

describe("SharedWithBadge", () => {
  it("should name the root channel's connected workspaces when the stream is a thread", async () => {
    const queryClient = new QueryClient()
    const seed = (streamId: string, connectedWorkspaces: { id: string; name: string }[]) =>
      queryClient.setQueryData(streamKeys.bootstrap(WORKSPACE_ID, streamId), {
        members: [],
        botMemberIds: [],
        connectedWorkspaces,
      })
    seed("stream_shared", [
      { id: "ws_globex", name: "Globex" },
      { id: "ws_initech", name: "Initech" },
    ])
    seed("stream_thread", [])

    render(
      <QueryClientProvider client={queryClient}>
        {/* No socket is provided, so the bootstrap is read from the seeded cache and never fetched. */}
        <ServicesProvider services={{ streams: {} as StreamService }}>
          <MemoryRouter>
            <SharedWithBadge
              workspaceId={WORKSPACE_ID}
              stream={{ id: "stream_thread", rootStreamId: "stream_shared" }}
            />
          </MemoryRouter>
        </ServicesProvider>
      </QueryClientProvider>
    )

    expect(await screen.findByText("Shared with Globex, Initech")).toBeTruthy()
  })
})
