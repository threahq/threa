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
  putStatus?: number
}

function installFetch({ flags, onPut, putStatus = 204 }: FetchConfig): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = init?.method ?? "GET"
      if (url.includes("/feature-flags") && method === "PUT") {
        onPut?.(init?.body ? JSON.parse(init.body as string) : undefined)
        if (putStatus >= 400) {
          return new Response(JSON.stringify({ error: "boom" }), {
            status: putStatus,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response(null, { status: putStatus })
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

function workspaceGroup() {
  return screen.findByRole("radiogroup", { name: "calls for the whole workspace" })
}

function flagCard(group: HTMLElement): HTMLElement {
  const card = group.closest("li")
  if (!card) throw new Error("flag card not found")
  return card
}

describe("WorkspaceDetailFlagsPage", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("selects the explicit default (not values[0]) when the workspace has no override", async () => {
    installFetch({ flags: callsFlags() })
    renderPage()

    const group = await workspaceGroup()
    expect(within(group).getByRole("radio", { name: "on" })).toBeChecked()
    expect(within(group).getByRole("radio", { name: "off" })).not.toBeChecked()
    expect(
      within(flagCard(group))
        .getByText(/^Default/)
        .closest("p")
    ).toHaveTextContent("Default on·Workspace and members")
    expect(within(flagCard(group)).queryByText("Changed")).not.toBeInTheDocument()
  })

  it("clears the workspace override when set back to the explicit default", async () => {
    const puts: unknown[] = []
    installFetch({ flags: callsFlags([workspaceOverride("off")]), onPut: (body) => puts.push(body) })
    renderPage()

    const group = await workspaceGroup()
    expect(within(group).getByRole("radio", { name: "off" })).toBeChecked()
    expect(within(flagCard(group)).getByText("Changed")).toBeInTheDocument()

    await userEvent.click(within(group).getByRole("radio", { name: "on" }))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ subjectType: "workspace", subjectId: WORKSPACE_ID, flagKey: "calls", value: "on" })
    await waitFor(() => expect(within(group).getByRole("radio", { name: "on" })).toBeChecked())
    expect(within(flagCard(group)).queryByText("Changed")).not.toBeInTheDocument()
  })

  it("adds a member override, then clears it back to inheriting", async () => {
    const puts: unknown[] = []
    installFetch({ flags: callsFlags(), onPut: (body) => puts.push(body) })
    renderPage()

    const add = await screen.findByRole("combobox", { name: "Add a member override for calls" })
    await userEvent.selectOptions(add, MEMBER_ID)

    const memberGroup = screen.getByRole("radiogroup", { name: "calls for Alice" })
    expect(within(memberGroup).queryByRole("radio", { checked: true })).not.toBeInTheDocument()
    expect(within(memberGroup).getByRole("radio", { name: "on" })).toBeDisabled()
    expect(screen.getByText("Everyone else:")).toHaveTextContent("Everyone else: on")

    await userEvent.click(within(memberGroup).getByRole("radio", { name: "off" }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ subjectType: "user", subjectId: MEMBER_ID, flagKey: "calls", value: "off" })
    await waitFor(() =>
      expect(
        within(screen.getByRole("radiogroup", { name: "calls for Alice" })).getByRole("radio", { name: "off" })
      ).toBeChecked()
    )

    await userEvent.click(screen.getByRole("button", { name: "Clear Alice's override" }))
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]).toEqual({ subjectType: "user", subjectId: MEMBER_ID, flagKey: "calls", value: "on" })
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "calls for Alice" })).not.toBeInTheDocument())
  })

  it("pins no member to the flag default while the workspace has moved off it", async () => {
    installFetch({
      flags: callsFlags([
        workspaceOverride("off"),
        {
          subjectType: "user",
          subjectId: MEMBER_ID,
          flagKey: "calls",
          value: "off",
          updatedAt: new Date().toISOString(),
        },
      ]),
    })
    renderPage()

    const memberGroup = await screen.findByRole("radiogroup", { name: "calls for Alice" })
    expect(within(memberGroup).getByRole("radio", { name: "on" })).toBeDisabled()
    expect(within(memberGroup).getByRole("radio", { name: "off" })).toBeChecked()
    expect(screen.getByText("Everyone else:")).toHaveTextContent("Everyone else: off")
  })

  it("offers no new member override when every value is either the default or inherited", async () => {
    installFetch({ flags: callsFlags([workspaceOverride("off")]) })
    renderPage()

    await workspaceGroup()
    expect(screen.queryByRole("combobox", { name: "Add a member override for calls" })).not.toBeInTheDocument()
  })

  it("keeps a new member row when saving its first value fails", async () => {
    installFetch({ flags: callsFlags(), putStatus: 500 })
    renderPage()

    const add = await screen.findByRole("combobox", { name: "Add a member override for calls" })
    await userEvent.selectOptions(add, MEMBER_ID)
    await userEvent.click(
      within(screen.getByRole("radiogroup", { name: "calls for Alice" })).getByRole("radio", { name: "off" })
    )

    expect(await screen.findByText(/Couldn't update flag/)).toBeInTheDocument()
    expect(screen.getByRole("radiogroup", { name: "calls for Alice" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel override for Alice" })).toBeInTheDocument()
  })
  it("names a registered flag by its label and description, keeping the key in the meta line", async () => {
    installFetch({
      flags: {
        flags: [{ key: "streamConnections", values: ["off", "on"], default: "off", scopes: ["workspace"] }],
        overrides: [],
      },
    })
    renderPage()

    const group = await screen.findByRole("radiogroup", { name: "Threa Connect for the whole workspace" })
    const card = flagCard(group)
    expect(within(card).getByRole("heading", { name: "Threa Connect" })).toBeInTheDocument()
    expect(within(card).getByText("Share channels with other workspaces.")).toBeInTheDocument()
    expect(
      within(card)
        .getByText(/^streamConnections/)
        .closest("p")
    ).toHaveTextContent("streamConnections·Default off·Workspace only")
  })
})
