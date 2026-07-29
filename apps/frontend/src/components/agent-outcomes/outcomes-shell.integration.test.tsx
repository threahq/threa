import type { AgentOutcomeSummary, ListAgentOutcomesResponse } from "@threa/types"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, userEvent, waitFor } from "@/test"
import * as agentOutcomesApiModule from "@/api/agent-outcomes"
import * as preferencesModule from "@/contexts/preferences-context"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { OutcomesShell } from "./outcomes-shell"

function makeFollowUp(overrides: Partial<AgentOutcomeSummary> = {}): AgentOutcomeSummary {
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
    ...overrides,
  } as AgentOutcomeSummary
}

function page(items: AgentOutcomeSummary[]): ListAgentOutcomesResponse {
  return { items, nextCursor: null, outstandingCount: items.length }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="search">{location.search}</div>
}

function renderShell(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <OutcomesShell workspaceId="ws_1" mode="page" enabled />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function searchParams(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId("search").textContent ?? "")
}

describe("OutcomesShell", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([])
    vi.spyOn(preferencesModule, "usePreferences").mockReturnValue({
      preferences: { dateFormat: "YYYY-MM-DD", timeFormat: "24h", timezone: "UTC" } as never,
    } as unknown as ReturnType<typeof preferencesModule.usePreferences>)
  })

  it("reads the default outstanding scope from the URL and issues a workspace-wide request", async () => {
    const listSpy = vi.spyOn(agentOutcomesApiModule.agentOutcomesApi, "list").mockResolvedValue(page([makeFollowUp()]))

    renderShell("/w/ws_1/agenda")

    await waitFor(() => expect(listSpy).toHaveBeenCalled())
    expect(listSpy.mock.calls[0]![1]).toMatchObject({ streamIds: [], state: "outstanding" })
    expect(await screen.findByText("Check in on the migration")).toBeInTheDocument()
  })

  it("a state chip drives both the URL and the request", async () => {
    const listSpy = vi.spyOn(agentOutcomesApiModule.agentOutcomesApi, "list").mockResolvedValue(page([makeFollowUp()]))

    renderShell("/w/ws_1/agenda")
    await waitFor(() => expect(listSpy).toHaveBeenCalled())

    await userEvent.setup().click(screen.getByRole("button", { name: "Settled" }))

    expect(searchParams().get("aState")).toBe("settled")
    await waitFor(() => {
      const last = listSpy.mock.calls[listSpy.mock.calls.length - 1]!
      expect(last[1]).toMatchObject({ state: "settled" })
    })
  })

  it("a kind chip narrows the request and toggles back off", async () => {
    const listSpy = vi.spyOn(agentOutcomesApiModule.agentOutcomesApi, "list").mockResolvedValue(page([makeFollowUp()]))

    renderShell("/w/ws_1/agenda")
    await waitFor(() => expect(listSpy).toHaveBeenCalled())
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Delegations" }))
    expect(searchParams().get("aKind")).toBe("delegation")
    await waitFor(() => {
      const last = listSpy.mock.calls[listSpy.mock.calls.length - 1]!
      expect(last[1]).toMatchObject({ kind: "delegation" })
    })

    await user.click(screen.getByRole("button", { name: "Delegations" }))
    expect(searchParams().has("aKind")).toBe(false)
  })

  it("selecting a row writes ?selected= and opens the detail", async () => {
    vi.spyOn(agentOutcomesApiModule.agentOutcomesApi, "list").mockResolvedValue(page([makeFollowUp()]))

    renderShell("/w/ws_1/agenda")

    const row = await screen.findByText("Check in on the migration")
    await userEvent.setup().click(row)

    expect(searchParams().get("aSelected")).toBe("fup_1")
    const detail = await screen.findByTestId("outcomes-detail")
    expect(detail).toHaveTextContent("Follow-up")
    expect(detail).toHaveTextContent("Scheduled")
  })

  it("removing the scope chip widens to the whole workspace", async () => {
    const listSpy = vi.spyOn(agentOutcomesApiModule.agentOutcomesApi, "list").mockResolvedValue(page([makeFollowUp()]))

    renderShell("/w/ws_1/agenda?aStreams=str_design")
    await waitFor(() => expect(listSpy.mock.calls[0]![1]).toMatchObject({ streamIds: ["str_design"] }))

    await userEvent.setup().click(screen.getByRole("button", { name: /Remove .* scope/ }))

    expect(searchParams().has("aStreams")).toBe(false)
    await waitFor(() => {
      const last = listSpy.mock.calls[listSpy.mock.calls.length - 1]!
      expect(last[1]).toMatchObject({ streamIds: [] })
    })
  })

  it("shows the first-run copy on the bare route, with nothing to clear", async () => {
    vi.spyOn(agentOutcomesApiModule.agentOutcomesApi, "list").mockResolvedValue(page([]))

    renderShell("/w/ws_1/agenda")

    const empty = await screen.findByTestId("outcomes-empty")
    expect(empty).toHaveTextContent("Nothing scheduled yet")
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument()
  })

  it("a filter that empties shows the filtered-empty state instead of stranding the view", async () => {
    vi.spyOn(agentOutcomesApiModule.agentOutcomesApi, "list").mockImplementation(async (_ws, filters) =>
      page(filters?.kind === "delegation" ? [] : [makeFollowUp()])
    )

    renderShell("/w/ws_1/agenda")
    await screen.findByText("Check in on the migration")

    await userEvent.setup().click(screen.getByRole("button", { name: "Delegations" }))

    const empty = await screen.findByTestId("outcomes-empty")
    expect(empty).toHaveTextContent("Nothing outstanding")
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument()
  })
})
