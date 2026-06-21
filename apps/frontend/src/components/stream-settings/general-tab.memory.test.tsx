import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ServicesProvider, type StreamService } from "@/contexts"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as e2eSession from "@/stores/e2e-session-store"
import * as descriptionSectionModule from "./description-section"
import { StreamTypes, Visibilities, MemoryModes, type Stream } from "@threa/types"
import { GeneralTab } from "./general-tab"

const WS = "ws_1"
const USER = "usr_alice"

function scratchpad(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_pad_1",
    workspaceId: WS,
    type: StreamTypes.SCRATCHPAD,
    displayName: "Build session",
    slug: null,
    description: null,
    visibility: Visibilities.PRIVATE,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    memoryMode: MemoryModes.AUTO,
    createdBy: USER,
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:00Z",
    archivedAt: null,
    ...overrides,
  }
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

describe("GeneralTab automatic-memory toggle", () => {
  beforeEach(() => {
    // The description section mounts the full rich-text editor (auth + workspace
    // context); stub it so these memory-toggle tests stay focused and provider-light.
    vi.spyOn(descriptionSectionModule, "DescriptionSection").mockImplementation(() => (
      <div data-testid="description-section" />
    ))
    // The display-name section reads the e2e session + workspace user id even
    // on a plaintext scratchpad; pin them so the tab mounts without a live
    // store (mirrors general-tab.rename.test.tsx).
    vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue(USER)
    vi.spyOn(e2eSession, "useE2eSession").mockReturnValue({
      status: "locked",
      keyId: null,
      publicKey: null,
      privateKey: null,
      deviceTrusted: false,
      error: null,
    } as ReturnType<typeof e2eSession.getE2eSessionState>)
  })

  afterEach(() => vi.restoreAllMocks())

  it("reflects memoryMode=auto as on and turns it off", async () => {
    const stream = scratchpad({ memoryMode: MemoryModes.AUTO })
    const update = vi.fn().mockResolvedValue({ ...stream, memoryMode: MemoryModes.OFF })

    renderTab(stream, update)

    const toggle = screen.getByRole("switch", { name: /automatic memory/i })
    expect(toggle).toBeChecked()

    await userEvent.click(toggle)

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith(WS, stream.id, { memoryMode: MemoryModes.OFF })
  })

  it("reflects memoryMode=off as off and turns it back on", async () => {
    const stream = scratchpad({ memoryMode: MemoryModes.OFF })
    const update = vi.fn().mockResolvedValue({ ...stream, memoryMode: MemoryModes.AUTO })

    renderTab(stream, update)

    const toggle = screen.getByRole("switch", { name: /automatic memory/i })
    expect(toggle).not.toBeChecked()

    await userEvent.click(toggle)

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith(WS, stream.id, { memoryMode: MemoryModes.AUTO })
  })

  it("treats a stream with no memoryMode (legacy cache) as on", () => {
    renderTab(scratchpad({ memoryMode: undefined }), vi.fn())
    expect(screen.getByRole("switch", { name: /automatic memory/i })).toBeChecked()
  })

  it("shows the toggle on a DM and toggles it", async () => {
    const stream = scratchpad({
      id: "stream_dm",
      type: StreamTypes.DM,
      displayName: null,
      memoryMode: MemoryModes.AUTO,
    })
    const update = vi.fn().mockResolvedValue({ ...stream, memoryMode: MemoryModes.OFF })

    renderTab(stream, update)

    await userEvent.click(screen.getByRole("switch", { name: /automatic memory/i }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith(WS, stream.id, { memoryMode: MemoryModes.OFF })
  })
})
