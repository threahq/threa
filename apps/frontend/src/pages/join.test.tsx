import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test"
import { ApiError } from "@/api/client"
import { invitationsApi } from "@/api/invitations"
import { JoinPage } from "./join"

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/join/token_1"]}>
        <Routes>
          <Route path="/join/:token" element={<JoinPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("JoinPage", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("should render a link with no expiration", async () => {
    vi.spyOn(invitationsApi, "lookupLink").mockResolvedValue({ workspaceName: "Acme", expiresAt: null })
    renderPage()
    expect(await screen.findByText("This link does not expire")).toBeInTheDocument()
  })

  it("should explain a used legacy link", async () => {
    vi.spyOn(invitationsApi, "lookupLink").mockRejectedValue(
      new ApiError(409, "INVITATION_ALREADY_CLAIMED", "Invitation already claimed")
    )
    renderPage()
    expect(await screen.findByRole("heading", { name: "Invite link already used" })).toBeInTheDocument()
  })

  it("should explain an exhausted link", async () => {
    vi.spyOn(invitationsApi, "lookupLink").mockRejectedValue(
      new ApiError(409, "INVITATION_EXHAUSTED", "Invitation exhausted")
    )
    renderPage()
    expect(await screen.findByRole("heading", { name: "Invitation link is full" })).toBeInTheDocument()
  })
})
