import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { WaitlistPage } from "./waitlist"
import type { WaitlistOverview } from "@/api/backoffice"

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WaitlistPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function installFetch(body: { waitlist?: WaitlistOverview; error?: string; code?: string }, status = 200) {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function makeOverview(overrides: Partial<WaitlistOverview> = {}): WaitlistOverview {
  return {
    entries: [],
    stats: { total: 0, pending: 0, invited: 0 },
    truncated: false,
    ...overrides,
  }
}

describe("WaitlistPage", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("renders the empty state when no one has joined", async () => {
    const fetchMock = installFetch({ waitlist: makeOverview() })
    renderPage()

    await screen.findByText(/No one has joined the waitlist yet/)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/backoffice/waitlist"),
      expect.objectContaining({ method: "GET" })
    )
  })

  it("renders the exact counts and one row per signup", async () => {
    installFetch({
      waitlist: makeOverview({
        stats: { total: 2, pending: 1, invited: 1 },
        entries: [
          {
            id: "wl_1",
            email: "alice@example.com",
            source: "marketing-hero",
            status: "pending",
            createdAt: new Date("2026-05-01T10:00:00Z").toISOString(),
          },
          {
            id: "wl_2",
            email: "bob@example.com",
            source: null,
            status: "invited",
            createdAt: new Date("2026-04-20T10:00:00Z").toISOString(),
          },
        ],
      }),
    })

    renderPage()

    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument()
    })
    // Both signups render
    expect(screen.getByText("bob@example.com")).toBeInTheDocument()
    // Source shows through, and a missing source falls back to "direct"
    expect(screen.getByText("marketing-hero")).toBeInTheDocument()
    expect(screen.getByText("direct")).toBeInTheDocument()
    // Status badges
    expect(screen.getByText("pending")).toBeInTheDocument()
    expect(screen.getByText("invited")).toBeInTheDocument()
    // Exact headline counts (Total / Pending / Invited each render their value)
    expect(screen.getByText("Total signups")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("filters the list by the search query", async () => {
    installFetch({
      waitlist: makeOverview({
        stats: { total: 2, pending: 2, invited: 0 },
        entries: [
          {
            id: "wl_1",
            email: "alice@example.com",
            source: null,
            status: "pending",
            createdAt: new Date().toISOString(),
          },
          {
            id: "wl_2",
            email: "bob@example.com",
            source: null,
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    })

    renderPage()

    await screen.findByText("alice@example.com")

    fireEvent.change(screen.getByPlaceholderText(/Search by email/), { target: { value: "bob" } })

    expect(screen.queryByText("alice@example.com")).not.toBeInTheDocument()
    expect(screen.getByText("bob@example.com")).toBeInTheDocument()
  })

  it("notes when the list is truncated", async () => {
    installFetch({
      waitlist: makeOverview({
        stats: { total: 600, pending: 600, invited: 0 },
        truncated: true,
        entries: [
          {
            id: "wl_1",
            email: "newest@example.com",
            source: null,
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    })

    renderPage()

    await screen.findByText(/most recent signups of/)
  })
})
