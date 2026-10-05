import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ServicesProvider, type StreamService } from "@/contexts"
import * as descriptionSectionModule from "./description-section"
import {
  StreamTypes,
  Visibilities,
  WORKSPACE_PERMISSION_SCOPES,
  type Stream,
  type WorkspaceBootstrap,
} from "@threahq/types"
import * as workspacesModule from "@/hooks/use-workspaces"
import { createMockStream } from "@/test/fixtures"
import { GeneralTab } from "./general-tab"

const WS = "ws_1"
const USER = "usr_alice"

function channel(overrides: Partial<Stream> = {}): Stream {
  return createMockStream({
    id: "stream_general",
    type: StreamTypes.CHANNEL,
    workspaceId: WS,
    slug: "general",
    visibility: Visibilities.PUBLIC,
    createdBy: USER,
    ...overrides,
  })
}

function renderTab(stream: Stream, update: ReturnType<typeof vi.fn>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider services={{ streams: { update } as unknown as StreamService }}>
        <GeneralTab workspaceId={WS} stream={stream} currentUserId={USER} notificationLevel={null} />
      </ServicesProvider>
    </QueryClientProvider>
  )
}

function viewerWith(viewerPermissions: WorkspaceBootstrap["viewerPermissions"]) {
  vi.spyOn(workspacesModule, "useViewerPermissions").mockReturnValue(viewerPermissions)
}

beforeEach(() => {
  viewerWith([WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE])
  vi.spyOn(workspacesModule, "useCurrentWorkspaceUser").mockReturnValue(null)
  vi.spyOn(descriptionSectionModule, "DescriptionSection").mockImplementation(({ locked }) => (
    <div data-testid="description-section" data-locked={locked ?? false} />
  ))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GeneralTab visibility", () => {
  it("should warn about guest access and send guest_public when a public channel is opened to guests", async () => {
    const stream = channel()
    const update = vi.fn().mockResolvedValue({ ...stream, visibility: Visibilities.GUEST_PUBLIC })
    renderTab(stream, update)

    await userEvent.click(screen.getByRole("button", { name: /Open to guests/ }))
    expect(await screen.findByText(/Members and guests will be able to find this channel/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(WS, stream.id, { visibility: Visibilities.GUEST_PUBLIC }))
  })

  it.each([
    [Visibilities.PRIVATE, "Open to guests", /Members and guests will be able to find this channel/],
    [Visibilities.GUEST_PUBLIC, "Public", /Guests who haven't joined will lose access/],
    [Visibilities.GUEST_PUBLIC, "Private", /Making this channel private will hide it from non-members/],
  ] as const)("should explain the change when a %s channel becomes %s", async (from, option, copy) => {
    renderTab(channel({ visibility: from }), vi.fn())

    await userEvent.click(screen.getByRole("button", { name: new RegExp(option) }))
    expect(await screen.findByText(copy)).toBeInTheDocument()
  })
})

describe("GeneralTab channel settings for a guest", () => {
  function settingsControls() {
    return {
      visibilityOptions: screen
        .getAllByRole("button", { name: /Public|Private|Open to guests/ })
        .map((option) => (option as HTMLButtonElement).disabled),
      slugDisabled: screen.getByPlaceholderText("channel-name").hasAttribute("disabled"),
      memoryDisabled: screen.getByRole("switch", { name: /automatic memory/i }).hasAttribute("disabled"),
      descriptionLocked: screen.getByTestId("description-section").getAttribute("data-locked"),
    }
  }

  it("should disable every channel setting when the viewer lacks browse", () => {
    viewerWith([])
    renderTab(channel(), vi.fn())

    expect(settingsControls()).toEqual({
      visibilityOptions: [true, true, true],
      slugDisabled: true,
      memoryDisabled: true,
      descriptionLocked: "true",
    })
  })

  it("should enable every channel setting when the viewer can browse", () => {
    renderTab(channel(), vi.fn())

    expect(settingsControls()).toEqual({
      visibilityOptions: [false, false, false],
      slugDisabled: false,
      memoryDisabled: false,
      descriptionLocked: "false",
    })
  })
})
