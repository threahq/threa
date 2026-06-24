import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router-dom"
import { StreamContextRow } from "./stream-context-row"
import * as hooks from "@/hooks"
import type { LinkContextItem } from "@/lib/stream-context/types"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(hooks, "useFormattedDate").mockReturnValue({
    formatRelative: () => "now",
  } as unknown as ReturnType<typeof hooks.useFormattedDate>)
})

function linkItem(url: string, overrides: Partial<LinkContextItem> = {}): LinkContextItem {
  return {
    key: `link:${url}`,
    category: "link",
    createdAt: "2026-06-24T10:00:00.000Z",
    sourceMessageId: "msg_1",
    snippet: "",
    url,
    title: "A link",
    siteName: null,
    faviconUrl: null,
    imageUrl: null,
    previewKind: "generic",
    badge: null,
    refCount: 1,
    ...overrides,
  }
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>
}

function renderRow(item: LinkContextItem) {
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <StreamContextRow
        workspaceId="ws_1"
        item={item}
        onJumpToMessage={vi.fn()}
        onOpenThread={vi.fn()}
        onOpenMemo={vi.fn()}
      />
      <LocationProbe />
    </MemoryRouter>
  )
}

describe("StreamContextRow link", () => {
  const origin = window.location.origin

  it("routes a same-origin link in-app (no new tab) and navigates on click", async () => {
    renderRow(linkItem(`${origin}/w/ws_1/s/stream_2?m=msg_3`))

    const anchor = screen.getByRole("link", { name: /open a link/i })
    expect(anchor).toHaveAttribute("href", "/w/ws_1/s/stream_2?m=msg_3")
    expect(anchor).not.toHaveAttribute("target")

    await userEvent.click(anchor)
    expect(screen.getByTestId("location")).toHaveTextContent("/w/ws_1/s/stream_2?m=msg_3")
  })

  it("opens an external link in a new tab and does not navigate in-app", async () => {
    renderRow(linkItem("https://github.com/acme/repo/pull/42"))

    const anchor = screen.getByRole("link", { name: /open a link/i })
    expect(anchor).toHaveAttribute("href", "https://github.com/acme/repo/pull/42")
    expect(anchor).toHaveAttribute("target", "_blank")
    expect(anchor).toHaveAttribute("rel", expect.stringContaining("noopener"))
    expect(screen.getByTestId("location")).toHaveTextContent("/start")
  })
})
