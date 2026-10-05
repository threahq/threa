import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { WorkspaceDetailOverviewPage } from "./workspace-detail-overview"
import { backofficeKeys, type WorkspaceDetail } from "@/api/backoffice"

const WORKSPACE_ID = "ws_abc"

const workspace: WorkspaceDetail = {
  id: WORKSPACE_ID,
  name: "Acme",
  slug: "acme",
  region: "local",
  tier: "full",
  createdByWorkosUserId: "user_01",
  workosOrganizationId: null,
  memberCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  owner: { workosUserId: "user_01", email: null, name: null },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function installFetch(onPut: (body: unknown) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/api/backoffice/config")) {
        return json({ config: { workspaceAppBaseUrl: "", workosEnvironmentId: null } })
      }
      if (url.includes(`/workspaces/${WORKSPACE_ID}/tier`) && init?.method === "PUT") {
        return onPut(JSON.parse(init.body as string))
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  )
}

function renderOverview(detail: WorkspaceDetail = workspace) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(backofficeKeys.workspace(WORKSPACE_ID), detail)
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/workspaces/${WORKSPACE_ID}`]}>
        <Routes>
          <Route path="/workspaces/:id" element={<WorkspaceDetailOverviewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("WorkspaceDetailOverviewPage tier", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("should show the stored tier and save the one the operator picks", async () => {
    const puts: unknown[] = []
    installFetch((body) => {
      puts.push(body)
      return json(body)
    })
    renderOverview()

    const select = await screen.findByRole<HTMLSelectElement>("combobox", { name: "Tier" })
    expect(select.value).toBe("full")

    await userEvent.selectOptions(select, "Connect")

    await waitFor(() => expect(puts).toEqual([{ tier: "connect" }]))
    await waitFor(() => expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Tier" })).toBeEnabled())
    expect({
      tier: screen.getByRole<HTMLSelectElement>("combobox", { name: "Tier" }).value,
      alert: screen.queryByRole("alert"),
    }).toEqual({ tier: "connect", alert: null })
  })

  it("should keep the stored tier and show an error when the save fails", async () => {
    installFetch(() => json({ error: "Invalid request body", code: "VALIDATION_ERROR" }, 400))
    renderOverview()

    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Tier" }), "Connect")

    const alert = await screen.findByRole("alert")
    expect({
      alert: alert.textContent,
      tier: screen.getByRole<HTMLSelectElement>("combobox", { name: "Tier" }).value,
    }).toEqual({ alert: "Invalid request body", tier: "full" })
  })
})

describe("WorkspaceDetailOverviewPage owner", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("should show the owner section as unclaimed when the workspace has no owner", async () => {
    installFetch(() => json({}))
    renderOverview({ ...workspace, createdByWorkosUserId: null, owner: null })

    await screen.findByRole("combobox", { name: "Tier" })
    expect(screen.getByText("Owner").closest("section")?.textContent).toBe("OwnerUnclaimed")
  })
})
