import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { render, screen, userEvent, waitFor } from "@/test"
import * as invitationsModule from "@/api/invitations"
import { InviteDialog } from "./invite-dialog"

afterEach(() => vi.restoreAllMocks())

it("should offer Member, Admin and Guest and send the guest role when Guest is picked", async () => {
  const send = vi.spyOn(invitationsModule.invitationsApi, "send").mockResolvedValue({ sent: [], skipped: [] })
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <InviteDialog workspaceId="ws_1" open onOpenChange={() => {}} onSuccess={() => {}} />
    </QueryClientProvider>
  )

  await user.type(screen.getByLabelText("Email addresses"), "guest@example.com")
  await user.click(screen.getByRole("combobox"))
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Member", "Admin", "Guest"])
  await user.click(screen.getByRole("option", { name: "Guest" }))
  await user.click(screen.getByRole("button", { name: "Send Invitations" }))

  await waitFor(() => expect(send).toHaveBeenCalledWith("ws_1", { emails: ["guest@example.com"], role: "guest" }))
})
