import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import * as contextsModule from "@/contexts"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { DocsHeaderChip } from "./docs-header-chip"

const WORKSPACE_ID = "ws_1"
const HOST_ID = "stream_host"

function doc(id: string, createdAt: string, overrides: Partial<workspaceStoreModule.CachedStream> = {}) {
  return {
    id,
    type: "doc",
    parentStreamId: HOST_ID,
    slug: null,
    displayName: null,
    createdAt,
    archivedAt: null,
    ...overrides,
  } as workspaceStoreModule.CachedStream
}

describe("DocsHeaderChip", () => {
  let streams: workspaceStoreModule.CachedStream[]

  beforeEach(() => {
    streams = []
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamsSelect").mockImplementation((_workspaceId, select) =>
      select(streams)
    )
    vi.spyOn(contextsModule, "usePanel").mockReturnValue({
      getPanelUrl: (panelId: string) => `/panel/${panelId}`,
    } as unknown as ReturnType<typeof contextsModule.usePanel>)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function mount() {
    return render(
      <MemoryRouter>
        <DocsHeaderChip workspaceId={WORKSPACE_ID} hostId={HOST_ID} />
      </MemoryRouter>
    )
  }

  it("should render nothing when the host has no live docs", () => {
    streams = [
      doc("stream_archived", "2026-10-01T10:00:00.000Z", { archivedAt: "2026-10-02T10:00:00.000Z" }),
      doc("stream_elsewhere", "2026-10-01T10:00:00.000Z", { parentStreamId: "stream_other" }),
    ]
    const { container } = mount()
    expect(container).toBeEmptyDOMElement()
  })

  it("should list the host's live docs newest first as links to their panes when opened", async () => {
    streams = [
      doc("stream_older", "2026-10-01T10:00:00.000Z"),
      doc("stream_newer", "2026-10-03T10:00:00.000Z"),
      doc("stream_archived", "2026-10-04T10:00:00.000Z", { archivedAt: "2026-10-05T10:00:00.000Z" }),
      { ...doc("stream_channel", "2026-10-04T10:00:00.000Z"), type: "channel" } as workspaceStoreModule.CachedStream,
    ]
    mount()

    const trigger = screen.getByRole("button", { name: "2 docs" })
    const triggerText = trigger.textContent
    await userEvent.click(trigger)

    const links = within(await screen.findByRole("menu")).getAllByRole("menuitem")
    expect({
      triggerText,
      links: links.map((link) => ({
        href: link.getAttribute("href"),
        label: link.querySelector(".truncate")?.textContent,
      })),
    }).toEqual({
      triggerText: "2",
      links: [
        { href: "/panel/stream_newer", label: "Untitled" },
        { href: "/panel/stream_older", label: "Untitled" },
      ],
    })
  })

  it("should name the trigger in the singular when the host has one doc", () => {
    streams = [doc("stream_only", "2026-10-01T10:00:00.000Z")]
    mount()
    expect(screen.getByRole("button", { name: "1 doc" })).toBeInTheDocument()
  })
})
