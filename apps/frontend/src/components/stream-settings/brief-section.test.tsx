import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, Visibilities, AuthorTypes, type Stream } from "@threa/types"
import { streamBriefsApi, type StreamBrief } from "@/api"
import { ApiError } from "@/api/client"
import { BriefSection } from "./brief-section"

afterEach(() => vi.restoreAllMocks())

function channel(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_chan",
    workspaceId: "ws_1",
    type: StreamTypes.CHANNEL,
    displayName: null,
    slug: "general",
    description: null,
    visibility: Visibilities.PUBLIC,
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_1",
    createdAt: "2026-06-22T10:00:00Z",
    updatedAt: "2026-06-22T10:00:00Z",
    archivedAt: null,
    ...overrides,
  }
}

function brief(overrides: Partial<StreamBrief> = {}): StreamBrief {
  return {
    id: "sbrf_1",
    workspaceId: "ws_1",
    streamId: "stream_chan",
    content: "Ship behind a flag.",
    version: 3,
    updatedByKind: AuthorTypes.USER,
    updatedById: "usr_1",
    createdAt: "2026-06-22T10:00:00Z",
    updatedAt: "2026-06-22T10:00:00Z",
    ...overrides,
  }
}

function renderSection(stream: Stream = channel()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <BriefSection workspaceId="ws_1" stream={stream} />
    </QueryClientProvider>
  )
}

describe("BriefSection", () => {
  it("renders the existing brief in a read view with an Edit affordance", async () => {
    vi.spyOn(streamBriefsApi, "get").mockResolvedValue(brief({ content: "Ship behind a flag." }))
    renderSection()

    expect(await screen.findByText("Ship behind a flag.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument()
  })

  it("offers an empty state when no brief exists yet", async () => {
    vi.spyOn(streamBriefsApi, "get").mockResolvedValue(null)
    renderSection()

    expect(await screen.findByRole("button", { name: "Add a brief" })).toBeInTheDocument()
  })

  it("saves an edit with the version the client read", async () => {
    vi.spyOn(streamBriefsApi, "get").mockResolvedValue(brief({ content: "Old", version: 3 }))
    const put = vi.spyOn(streamBriefsApi, "put").mockResolvedValue(brief({ content: "New", version: 4 }))
    renderSection()

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }))
    const textarea = screen.getByRole("textbox", { name: "Stream brief editor" })
    await userEvent.clear(textarea)
    await userEvent.type(textarea, "New")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(put).toHaveBeenCalledWith("ws_1", "stream_chan", { content: "New", version: 3 }))
    // Success returns to the read view with the fresh content.
    expect(await screen.findByText("New")).toBeInTheDocument()
  })

  it("surfaces a concurrent edit inline instead of overwriting silently (INV-63)", async () => {
    vi.spyOn(streamBriefsApi, "get").mockResolvedValue(brief({ content: "Old", version: 3 }))
    vi.spyOn(streamBriefsApi, "put").mockRejectedValue(
      new ApiError(409, "BRIEF_VERSION_CONFLICT", "conflict", { current: brief({ content: "Theirs", version: 4 }) })
    )
    renderSection()

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }))
    const textarea = screen.getByRole("textbox", { name: "Stream brief editor" })
    await userEvent.clear(textarea)
    await userEvent.type(textarea, "Mine")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText(/Someone else updated this brief/)).toBeInTheDocument()
    // The editor stays open with the user's in-progress text — nothing lost.
    expect(screen.getByRole("textbox", { name: "Stream brief editor" })).toHaveValue("Mine")
  })
})
