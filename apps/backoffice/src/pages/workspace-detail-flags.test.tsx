import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, waitFor, within, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { WorkspaceDetailFlagsPage } from "./workspace-detail-flags"
import type { WorkspaceFeatureFlags, WorkspaceMember } from "@/api/backoffice"

const WORKSPACE_ID = "ws_abc"
const MEMBER_ID = "workos_user_1"

// A flag whose explicit default is NOT its first declared value — the case the
// backoffice reconstructed wrongly as values[0] before the wire type carried
// `default` (chunk-5 `calls` is exactly this shape).
function callsFlags(overrides: WorkspaceFeatureFlags["overrides"] = []): WorkspaceFeatureFlags {
  return {
    flags: [{ key: "calls", values: ["off", "on"], default: "on", scopes: ["workspace", "user"] }],
    overrides,
  }
}

function workspaceOverride(value: string): WorkspaceFeatureFlags["overrides"][number] {
  return {
    subjectType: "workspace",
    subjectId: WORKSPACE_ID,
    flagKey: "calls",
    value,
    updatedAt: new Date().toISOString(),
  }
}

const MEMBERS: WorkspaceMember[] = [
  {
    workosUserId: MEMBER_ID,
    email: "alice@example.com",
    firstName: "Alice",
    lastName: null,
    status: "active",
    roleSlugs: [],
    lastEventAt: new Date().toISOString(),
  },
]

interface FetchConfig {
  flags: WorkspaceFeatureFlags
  onPut?: (body: unknown) => void
}

function installFetch({ flags, onPut }: FetchConfig): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = init?.method ?? "GET"
      if (url.includes("/feature-flags") && method === "PUT") {
        onPut?.(init?.body ? JSON.parse(init.body as string) : undefined)
        return new Response(null, { status: 204 })
      }
      if (url.includes("/feature-flags")) {
        return new Response(JSON.stringify(flags), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (url.includes("/members")) {
        return new Response(JSON.stringify({ members: MEMBERS }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    })
  )
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/workspaces/${WORKSPACE_ID}/flags`]}>
        <Routes>
          <Route path="/workspaces/:id/flags" element={<WorkspaceDetailFlagsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("WorkspaceDetailFlagsPage default handling", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("shows the explicit default (not values[0]) and marks the (default) option on it", async () => {
    installFetch({ flags: callsFlags() })
    renderPage()

    const [workspaceSelect] = await screen.findAllByLabelText<HTMLSelectElement>("calls")
    // No override → resolves to the flag's explicit default "on", not values[0] "off".
    expect(workspaceSelect.value).toBe("on")
    // The (default) suffix rides the explicit default, not the first-declared value.
    expect(within(workspaceSelect).getByRole("option", { name: "on (default)" })).toBeInTheDocument()
    expect(within(workspaceSelect).getByRole("option", { name: "off" })).toBeInTheDocument()
    // At its default, the control is not highlighted as a deviation.
    expect(workspaceSelect.className).not.toContain("emerald")
  })

  it("shows a member the inherited workspace value without a false deviation highlight", async () => {
    // Workspace set to the non-default "off"; the member has no personal override.
    installFetch({ flags: callsFlags([workspaceOverride("off")]) })
    renderPage()

    const [workspaceSelect, memberSelect] = await screen.findAllByLabelText<HTMLSelectElement>("calls")
    // Workspace deviates from the default → highlighted.
    expect(workspaceSelect.value).toBe("off")
    expect(workspaceSelect.className).toContain("emerald")
    // Member inherits the workspace value (off), and is NOT falsely highlighted —
    // they match their inherited baseline, they haven't deviated from it.
    expect(memberSelect.value).toBe("off")
    expect(memberSelect.className).not.toContain("emerald")
  })

  it("clears the override when set back to the explicit default", async () => {
    const puts: unknown[] = []
    installFetch({ flags: callsFlags([workspaceOverride("off")]), onPut: (body) => puts.push(body) })
    renderPage()

    const [workspaceSelect] = await screen.findAllByLabelText<HTMLSelectElement>("calls")
    expect(workspaceSelect.value).toBe("off")

    await userEvent.selectOptions(workspaceSelect, "on")

    // The PUT carries the explicit default; the optimistic cache clears the
    // override (defaultValue === value), agreeing with the server's clear.
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({
      subjectType: "workspace",
      subjectId: WORKSPACE_ID,
      flagKey: "calls",
      value: "on",
    })
    await waitFor(() => expect(workspaceSelect.value).toBe("on"))
    expect(workspaceSelect.className).not.toContain("emerald")
  })
})
