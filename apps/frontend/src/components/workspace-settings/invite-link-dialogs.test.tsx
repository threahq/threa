import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, userEvent, waitFor } from "@/test"
import type { CreateInvitationLinkResponse, UpdateInvitationLinkResponse, WorkspaceInvitation } from "@threahq/types"
import * as invitationsModule from "@/api/invitations"
import { CreateInviteLinkDialog } from "./create-invite-link-dialog"
import { buildInviteLinkPatch, EditInviteLinkDialog } from "./edit-invite-link-dialog"
import { isoToLocalDateTime } from "./invite-link-settings-fields"

const invitation: WorkspaceInvitation = {
  id: "inv_1",
  workspaceId: "ws_1",
  kind: "link",
  email: null,
  role: "member",
  invitedBy: "usr_1",
  status: "pending",
  note: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T12:34:56.789Z",
  acceptedAt: null,
  maxUses: 2,
  useCount: 0,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe("invite link dialogs", () => {
  it("should omit unchanged edit settings without rounding the original expiry", () => {
    expect(
      buildInviteLinkPatch(invitation, {
        unlimited: false,
        maxUses: "2",
        neverExpires: false,
        expiresAt: isoToLocalDateTime(invitation.expiresAt),
      })
    ).toEqual({})
  })

  it("should preserve an untouched ambiguous local expiry instant", () => {
    vi.stubEnv("TZ", "Europe/Stockholm")
    const ambiguous = { ...invitation, expiresAt: "2026-10-25T01:30:45.678Z" }
    expect(isoToLocalDateTime(ambiguous.expiresAt)).toBe("2026-10-25T02:30")
    expect(
      buildInviteLinkPatch(ambiguous, {
        unlimited: true,
        maxUses: "2",
        neverExpires: false,
        expiresAt: "2026-10-25T02:30",
      })
    ).toEqual({ maxUses: null })
  })

  it("should close an unchanged edit without sending an empty patch", async () => {
    const update = vi.spyOn(invitationsModule.invitationsApi, "updateLink")
    const onOpenChange = vi.fn()
    renderWithQuery(
      <EditInviteLinkDialog
        workspaceId="ws_1"
        invitation={invitation}
        open
        onOpenChange={onOpenChange}
        onSuccess={vi.fn()}
      />
    )
    await screen.findByLabelText("Maximum joins")
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(update).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("should name the immutable admin role and fix its limit at one while editing", async () => {
    renderWithQuery(
      <EditInviteLinkDialog
        workspaceId="ws_1"
        invitation={{ ...invitation, role: "admin", maxUses: 1 }}
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    )
    expect(await screen.findByText("Anyone with this link can join the workspace as admin.")).toBeInTheDocument()
    expect(screen.getByLabelText("Maximum joins")).toHaveValue(1)
    expect(screen.getByLabelText("Maximum joins")).toBeDisabled()
    expect(screen.queryByRole("switch", { name: "Unlimited" })).not.toBeInTheDocument()
  })

  it("should preserve another admin's expiry change when saving an in-progress limit edit", async () => {
    const refreshed = { ...invitation, expiresAt: "2100-02-01T12:34:56.789Z" }
    const update = vi.spyOn(invitationsModule.invitationsApi, "updateLink").mockResolvedValue({
      invitation: { ...refreshed, maxUses: 9 },
    })
    const client = new QueryClient()
    const props = { workspaceId: "ws_1", open: true, onOpenChange: vi.fn(), onSuccess: vi.fn() }
    const view = render(
      <QueryClientProvider client={client}>
        <EditInviteLinkDialog {...props} invitation={invitation} />
      </QueryClientProvider>
    )
    const input = await screen.findByLabelText("Maximum joins")
    await userEvent.clear(input)
    await userEvent.type(input, "9")
    view.rerender(
      <QueryClientProvider client={client}>
        <EditInviteLinkDialog {...props} invitation={refreshed} />
      </QueryClientProvider>
    )
    expect(screen.getByLabelText("Maximum joins")).toHaveValue(9)
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "inv_1", { maxUses: 9 }))
  })

  it("should clear a failed edit before reopening", async () => {
    const update = vi
      .spyOn(invitationsModule.invitationsApi, "updateLink")
      .mockRejectedValueOnce(new Error("Save failed"))
    const props = { workspaceId: "ws_1", invitation, onOpenChange: vi.fn(), onSuccess: vi.fn() }
    const view = renderWithQuery(<EditInviteLinkDialog {...props} open />)
    const limit = await screen.findByLabelText("Maximum joins")
    await userEvent.clear(limit)
    await userEvent.type(limit, "9")
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed")

    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <EditInviteLinkDialog {...props} open={false} />
      </QueryClientProvider>
    )
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <EditInviteLinkDialog {...props} open />
      </QueryClientProvider>
    )
    await screen.findByLabelText("Maximum joins")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    update.mockRestore()
  })

  it("should ignore an edit response after close and reopen", async () => {
    const request = deferred<UpdateInvitationLinkResponse>()
    vi.spyOn(invitationsModule.invitationsApi, "updateLink").mockReturnValueOnce(request.promise)
    const onOpenChange = vi.fn()
    const onSuccess = vi.fn()
    const client = new QueryClient()
    const view = render(
      <QueryClientProvider client={client}>
        <EditInviteLinkDialog
          workspaceId="ws_1"
          invitation={invitation}
          open
          onOpenChange={onOpenChange}
          onSuccess={onSuccess}
        />
      </QueryClientProvider>
    )
    const limit = await screen.findByLabelText("Maximum joins")
    await userEvent.clear(limit)
    await userEvent.type(limit, "9")
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    view.rerender(
      <QueryClientProvider client={client}>
        <EditInviteLinkDialog
          workspaceId="ws_1"
          invitation={invitation}
          open={false}
          onOpenChange={onOpenChange}
          onSuccess={onSuccess}
        />
      </QueryClientProvider>
    )
    view.rerender(
      <QueryClientProvider client={client}>
        <EditInviteLinkDialog
          workspaceId="ws_1"
          invitation={invitation}
          open
          onOpenChange={onOpenChange}
          onSuccess={onSuccess}
        />
      </QueryClientProvider>
    )
    request.resolve({ invitation })
    await waitFor(() => expect(screen.getByLabelText("Maximum joins")).toBeInTheDocument())
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("should retain a completed link without replacing the reopened create dialog", async () => {
    const request = deferred<CreateInvitationLinkResponse>()
    vi.spyOn(invitationsModule.invitationsApi, "createLink").mockReturnValueOnce(request.promise)
    const client = new QueryClient()
    const props = { workspaceId: "ws_1", onOpenChange: vi.fn(), onSuccess: vi.fn(), onTokenCreated: vi.fn() }
    const view = render(
      <QueryClientProvider client={client}>
        <CreateInviteLinkDialog {...props} open />
      </QueryClientProvider>
    )
    expect(screen.getByText("Anyone with this link can join the workspace as member.")).toBeInTheDocument()
    expect(screen.queryByText("Admin")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Create link" }))
    expect(invitationsModule.invitationsApi.createLink).toHaveBeenCalledWith(
      "ws_1",
      expect.objectContaining({ role: "member" })
    )
    view.rerender(
      <QueryClientProvider client={client}>
        <CreateInviteLinkDialog {...props} open={false} />
      </QueryClientProvider>
    )
    view.rerender(
      <QueryClientProvider client={client}>
        <CreateInviteLinkDialog {...props} open />
      </QueryClientProvider>
    )
    request.resolve({ invitation, token: "old-token" })

    await waitFor(() =>
      expect(screen.getByText("Anyone with this link can join the workspace as member.")).toBeInTheDocument()
    )
    expect(screen.queryByLabelText("Share link")).not.toBeInTheDocument()
    await waitFor(() => expect(props.onTokenCreated).toHaveBeenCalledWith(invitation.id, "old-token"))
    expect(props.onSuccess).toHaveBeenCalledOnce()
  })
})
