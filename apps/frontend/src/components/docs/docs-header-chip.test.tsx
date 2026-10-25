import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import * as contextsModule from "@/contexts"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { DocsHeaderChip } from "./docs-header-chip"

const WORKSPACE_ID = "ws_1"
const HOST_ID = "stream_host"
const NOW = new Date("2026-10-26T12:00:00.000Z")

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

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
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
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
    vi.useRealTimers()
  })

  async function openMenuItems() {
    await userEvent.click(screen.getByRole("button", { name: /docs?$/ }))
    return within(await screen.findByRole("menu"))
      .getAllByRole("menuitem")
      .map((link) => ({
        href: link.getAttribute("href"),
        text: [...link.querySelectorAll("span")].map((span) => span.textContent),
      }))
  }

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
      doc("stream_older", minutesAgo(30)),
      doc("stream_newer", minutesAgo(5)),
      doc("stream_archived", minutesAgo(1), { archivedAt: minutesAgo(0) }),
      { ...doc("stream_channel", minutesAgo(1)), type: "channel" } as workspaceStoreModule.CachedStream,
    ]
    mount()

    const triggerText = screen.getByRole("button", { name: "2 docs" }).textContent

    expect({ triggerText, items: await openMenuItems() }).toEqual({
      triggerText: "2",
      items: [
        { href: "/panel/stream_newer", text: ["Untitled", "5m ago"] },
        { href: "/panel/stream_older", text: ["Untitled", "30m ago"] },
      ],
    })
  })

  it("should date the docs from when the menu opens, not from when the chip rendered", async () => {
    streams = [doc("stream_only", minutesAgo(5))]
    mount()

    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000))

    expect(await openMenuItems()).toEqual([{ href: "/panel/stream_only", text: ["Untitled", "15m ago"] }])
  })

  it("should name the trigger in the singular when the host has one doc", () => {
    streams = [doc("stream_only", minutesAgo(5))]
    mount()
    expect(screen.getByRole("button", { name: "1 doc" })).toBeInTheDocument()
  })
})
