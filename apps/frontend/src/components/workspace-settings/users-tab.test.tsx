import { expect, it, vi } from "vitest"
import { render, screen } from "@/test"
import { PendingEmailInvitationDetails } from "./users-tab"

it("should retain role and local expiry for pending email invitations", () => {
  const formatDate = vi.fn(() => "Jan 8, 2027")
  render(
    <PendingEmailInvitationDetails
      email="invitee@example.com"
      role="admin"
      expiresAt="2027-01-08T10:00:00.000Z"
      formatDate={formatDate}
    />
  )

  expect(screen.getByText("invitee@example.com")).toBeInTheDocument()
  expect(screen.getByText("admin")).toBeInTheDocument()
  expect(screen.getByText("Expires Jan 8, 2027")).toBeInTheDocument()
  expect(formatDate).toHaveBeenCalledWith(new Date("2027-01-08T10:00:00.000Z"))
})
