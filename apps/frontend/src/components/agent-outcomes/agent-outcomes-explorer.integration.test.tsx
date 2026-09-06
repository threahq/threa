import type { AgentOutcomeSummary, ListAgentOutcomesResponse } from "@threahq/types"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, userEvent, waitFor } from "@/test"
import * as agentOutcomesApiModule from "@/api/agent-outcomes"
import * as preferencesModule from "@/contexts/preferences-context"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { AgentOutcomesExplorer } from "./agent-outcomes-explorer"

function followUp(): AgentOutcomeSummary {
  return {
    kind: "follow_up",
    id: "fup_1",
    streamId: "str_design",
    title: "Check in on the migration",
    status: "pending",
    scheduledFor: "2026-08-01T18:00:00.000Z",
    claimedByLabel: null,
    statusNote: null,
    resultMessageId: null,
    actorType: "persona",
    actorId: "persona_1",
    createdAt: "2026-07-28T09:00:00.000Z",
    statusChangedAt: "2026-07-28T09:00:00.000Z",
    occursAt: "2026-08-01T18:00:00.000Z",
    anchorEventId: "event_1",
  } as AgentOutcomeSummary
}

function page(items: AgentOutcomeSummary[]): ListAgentOutcomesResponse {
  return { items, nextCursor: null, outstandingCount: items.length }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="search">{location.search}</div>
}

function renderExplorer(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <AgentOutcomesExplorer workspaceId="ws_1" />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("AgentOutcomesExplorer", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([])
    vi.spyOn(preferencesModule, "usePreferences").mockReturnValue({
      preferences: { dateFormat: "YYYY-MM-DD", timeFormat: "24h", timezone: "UTC" } as never,
    } as unknown as ReturnType<typeof preferencesModule.usePreferences>)
  })

  it("stays closed — and fetches nothing — until the URL says otherwise", async () => {
    const listSpy = vi.spyOn(agentOutcomesApiModule.agentOutcomesApi, "list").mockResolvedValue(page([followUp()]))

    renderExplorer("/w/ws_1/s/str_design")

    expect(screen.queryByText("Check in on the migration")).not.toBeInTheDocument()
    // The dialog is unmounted, so the shell's query must never have been armed.
    await waitFor(() => expect(listSpy).not.toHaveBeenCalled())
  })

  it("opens over the current route from the marker, scoped to the stream it was opened from", async () => {
    const listSpy = vi.spyOn(agentOutcomesApiModule.agentOutcomesApi, "list").mockResolvedValue(page([followUp()]))

    renderExplorer("/w/ws_1/s/str_design?agenda=&aStreams=str_design")

    expect(await screen.findByText("Check in on the migration")).toBeInTheDocument()
    expect(listSpy.mock.calls[0]?.[1]).toMatchObject({ streamIds: ["str_design"] })
  })

  it("closing strips only this surface's params, leaving the host route's own", async () => {
    vi.spyOn(agentOutcomesApiModule.agentOutcomesApi, "list").mockResolvedValue(page([followUp()]))

    renderExplorer("/w/ws_1/s/str_design?thread=stream_t&agenda=&aStreams=str_design&aState=all")
    await screen.findByText("Check in on the migration")

    await userEvent.click(screen.getByRole("button", { name: "Close" }))

    await waitFor(() => {
      const search = new URLSearchParams(screen.getByTestId("search").textContent ?? "")
      expect({
        agenda: search.has("agenda"),
        scope: search.has("aStreams"),
        state: search.has("aState"),
        thread: search.get("thread"),
      }).toEqual({ agenda: false, scope: false, state: false, thread: "stream_t" })
    })
  })
})
