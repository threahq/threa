import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ServicesProvider, type StreamService } from "@/contexts"
import { StreamTypes, Visibilities, WORKSPACE_PERMISSION_SCOPES, type Stream } from "@threahq/types"
import { streamsApi } from "@/api/streams"
import * as workspacesModule from "@/hooks/use-workspaces"
import { createMockStream } from "@/test/fixtures"
import * as descriptionSectionModule from "./description-section"
import { GeneralTab } from "./general-tab"

const WS = "ws_1"
const USER = "usr_alice"

function stream(overrides: Partial<Stream> & Pick<Stream, "type">): Stream {
  return createMockStream({
    id: "stream_1",
    workspaceId: WS,
    visibility: Visibilities.PUBLIC,
    createdBy: USER,
    ...overrides,
  })
}

function renderTab(target: Stream, update: ReturnType<typeof vi.fn>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider services={{ streams: { update } as unknown as StreamService }}>
        <button type="button">elsewhere</button>
        <GeneralTab workspaceId={WS} stream={target} currentUserId={USER} notificationLevel={null} />
      </ServicesProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(workspacesModule, "useViewerPermissions").mockReturnValue([WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE])
  vi.spyOn(workspacesModule, "useCurrentWorkspaceUser").mockReturnValue(null)
  vi.spyOn(workspacesModule, "useWorkspaceUserId").mockReturnValue(USER)
  vi.spyOn(descriptionSectionModule, "DescriptionSection").mockImplementation(() => <div />)
})

afterEach(() => vi.restoreAllMocks())

describe("GeneralTab names save like every other field", () => {
  it("renames a channel when the slug field loses focus, with no Save button", async () => {
    vi.spyOn(streamsApi, "checkSlugAvailable").mockResolvedValue(true)
    const channel = stream({ type: StreamTypes.CHANNEL, slug: "general" })
    const update = vi.fn().mockResolvedValue({ ...channel, slug: "launch" })
    renderTab(channel, update)

    const input = screen.getByPlaceholderText("channel-name")
    await userEvent.clear(input)
    await userEvent.type(input, "launch")
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(WS, channel.id, { slug: "launch" }))
  })

  it("should show Saving while a slug save is in flight", async () => {
    vi.spyOn(streamsApi, "checkSlugAvailable").mockResolvedValue(true)
    const channel = stream({ type: StreamTypes.CHANNEL, slug: "general" })
    let finish: (value: Stream) => void = () => undefined
    const update = vi.fn().mockReturnValue(new Promise<Stream>((resolve) => (finish = resolve)))
    renderTab(channel, update)

    const input = screen.getByPlaceholderText("channel-name")
    await userEvent.clear(input)
    await userEvent.type(input, "launch")
    await waitFor(() => expect(streamsApi.checkSlugAvailable).toHaveBeenCalledWith(WS, "launch", channel.id))
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }))

    expect(await screen.findByRole("status")).toHaveTextContent("Saving")
    finish({ ...channel, slug: "launch" })
  })

  it("holds an invalid slug instead of saving it", async () => {
    const channel = stream({ type: StreamTypes.CHANNEL, slug: "general" })
    const update = vi.fn()
    renderTab(channel, update)

    const input = screen.getByPlaceholderText("channel-name")
    await userEvent.clear(input)
    await userEvent.type(input, "-{Enter}")
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }))

    expect(update).not.toHaveBeenCalled()
    expect(input).toHaveValue("-")
  })

  it("says why a slug is invalid in an alert the field points at", async () => {
    const channel = stream({ type: StreamTypes.CHANNEL, slug: "general" })
    renderTab(channel, vi.fn())

    const input = screen.getByPlaceholderText("channel-name")
    await userEvent.clear(input)
    await userEvent.type(input, "-")

    const alert = await screen.findByRole("alert")
    expect({
      alert: alert.textContent,
      invalid: input.getAttribute("aria-invalid"),
      points: input.getAttribute("aria-errormessage") === alert.id,
    }).toEqual({
      alert: "Start with a letter. Lowercase letters, numbers, hyphens and underscores only.",
      invalid: "true",
      points: true,
    })
  })

  it("renames a scratchpad on Enter", async () => {
    const scratchpad = stream({ type: StreamTypes.SCRATCHPAD, displayName: "Notes", visibility: Visibilities.PRIVATE })
    const update = vi.fn().mockResolvedValue({ ...scratchpad, displayName: "Plans" })
    renderTab(scratchpad, update)

    const input = screen.getByPlaceholderText("Scratchpad name")
    await userEvent.clear(input)
    await userEvent.type(input, "Plans{Enter}")

    await waitFor(() => expect(update).toHaveBeenCalledWith(WS, scratchpad.id, { displayName: "Plans" }))
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
  })

  it("keeps Regenerate title in place but disabled while the name has unsaved edits", async () => {
    const scratchpad = stream({ type: StreamTypes.SCRATCHPAD, displayName: "Notes", visibility: Visibilities.PRIVATE })
    renderTab(scratchpad, vi.fn())

    const regenerate = screen.getByRole("button", { name: "Regenerate title" })
    expect(regenerate).toBeEnabled()
    await userEvent.type(screen.getByPlaceholderText("Scratchpad name"), "!")
    expect(regenerate).toBeDisabled()
  })
})
