import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { spyOnExport } from "@/test"
import * as hooksModule from "@/hooks"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as slugInputModule from "@/components/stream-settings/channel-slug-input"
import { CreateChannelDialog } from "./create-channel-dialog"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("CreateChannelDialog", () => {
  it("should send visibility guest_public when the channel is created open to guests", async () => {
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
