import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router-dom"
import { spyOnExport } from "@/test"
import { WORKSPACE_PERMISSION_SCOPES, type WorkspaceBootstrap } from "@threahq/types"
import * as hooksModule from "@/hooks"
import * as workspacesModule from "@/hooks/use-workspaces"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as slugInputModule from "@/components/stream-settings/channel-slug-input"
import { CreateChannelDialog } from "./create-channel-dialog"

beforeEach(() => {
  vi.spyOn(workspacesModule, "useCurrentWorkspaceUser").mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function viewerWith(viewerPermissions: WorkspaceBootstrap["viewerPermissions"]) {
  vi.spyOn(workspacesModule, "useCachedWorkspaceBootstrap").mockReturnValue({ viewerPermissions } as WorkspaceBootstrap)
}

describe("CreateChannelDialog", () => {
  it("should render no dialog when a guest opens the create-channel URL", () => {
    viewerWith([])
    vi.spyOn(hooksModule, "useCreateStream").mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as never)
    vi.spyOn(authModule, "useAuth").mockReturnValue({ user: null } as never)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)

    render(
      <MemoryRouter initialEntries={["/w/ws_1?create-channel="]}>
        <CreateChannelDialog workspaceId="ws_1" />
      </MemoryRouter>
    )

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("should open the dialog once bootstrap lands and keep the create-channel URL until then", async () => {
    const bootstrap = vi.spyOn(workspacesModule, "useCachedWorkspaceBootstrap").mockReturnValue(null)
    vi.spyOn(hooksModule, "useCreateStream").mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as never)
    vi.spyOn(authModule, "useAuth").mockReturnValue({ user: null } as never)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
    function Search() {
      return <output data-testid="search">{useLocation().search}</output>
    }
    const tree = () => (
      <MemoryRouter initialEntries={["/w/ws_1?create-channel="]}>
        <CreateChannelDialog workspaceId="ws_1" />
        <Search />
      </MemoryRouter>
    )

    const view = render(tree())
    const beforeBootstrap = {
      dialog: screen.queryByRole("dialog") !== null,
      search: screen.getByTestId("search").textContent,
    }
    bootstrap.mockReturnValue({
      viewerPermissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE],
    } as WorkspaceBootstrap)
    view.rerender(tree())

    const dialogAfter = (await screen.findByRole("dialog")) !== null

    expect({ beforeBootstrap, dialogAfter, searchAfter: screen.getByTestId("search").textContent }).toEqual({
      beforeBootstrap: { dialog: false, search: "?create-channel=" },
      dialogAfter: true,
      searchAfter: "?create-channel=",
    })
  })

  it("should send visibility guest_public when the channel is created open to guests", async () => {
    viewerWith([WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE])
    const mutateAsync = vi.fn().mockResolvedValue({ id: "stream_new" })
    vi.spyOn(hooksModule, "useCreateStream").mockReturnValue({ mutateAsync, isPending: false } as never)
    vi.spyOn(authModule, "useAuth").mockReturnValue({ user: null } as never)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
    spyOnExport(slugInputModule, "ChannelSlugInput").mockReturnValue((({ onChange, onValidityChange }) => (
      <button
        type="button"
        onClick={() => {
          onChange("guests-welcome")
          onValidityChange(true)
        }}
      >
        set slug
      </button>
    )) as typeof slugInputModule.ChannelSlugInput)

    render(
      <MemoryRouter initialEntries={["/w/ws_1?create-channel="]}>
        <CreateChannelDialog workspaceId="ws_1" />
      </MemoryRouter>
    )

    await userEvent.click(screen.getByRole("button", { name: "set slug" }))
    await userEvent.click(screen.getByRole("button", { name: /Open to guests/ }))
    await userEvent.click(screen.getByRole("button", { name: "Create Channel" }))

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        type: "channel",
        slug: "guests-welcome",
        description: undefined,
        visibility: "guest_public",
        memberIds: undefined,
      })
    )
  })
})
