import { describe, it, expect } from "vitest"
import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, Link, RouterProvider, useLocation } from "react-router-dom"
import { PanelProvider, PaneScope, usePanel } from "./panel-context"

/**
 * On mobile an open panel takes over the whole screen, so the platform back
 * gesture has to close it rather than leave the page. These exercise the real
 * router: `router.navigate(-1)` is the back gesture, and the assertions are on
 * where it lands.
 */

function Probe() {
  const { openPanel, closePanel, getPanelUrl } = usePanel()
  const location = useLocation()
  return (
    <div>
      <span data-testid="loc">{`${location.pathname}${location.search}`}</span>
      <button onClick={() => openPanel("conv:a")}>open a</button>
      <button onClick={() => openPanel("conv:b", { replace: true })}>supersede with b</button>
      {/* How most panels actually open — branch rows, thread anchors (INV-40). */}
      <Link to={getPanelUrl("conv:c")}>link to c</Link>
      <button onClick={closePanel}>close</button>
    </div>
  )
}

function mount(initialEntries: string[], probe = <Probe />) {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: <PanelProvider>{probe}</PanelProvider>,
      },
    ],
    { initialEntries, initialIndex: initialEntries.length - 1 }
  )
  render(<RouterProvider router={router} />)
  const back = async () => {
    await act(async () => {
      await router.navigate(-1)
    })
  }
  return { back, loc: () => screen.getByTestId("loc").textContent }
}

const BOARD = "/board?lens=all"
const STREAM = "/s/stream_1"

describe("panel history", () => {
  it("pushes an entry, so back closes the panel instead of leaving the page", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("button", { name: "open a" }))
    expect(loc()).toBe("/board?lens=all&panel=conv%3Aa")

    await back()
    expect(loc()).toBe(BOARD)
  })

  it("pops the entry it pushed when closed in the UI, leaving no duplicate", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("button", { name: "open a" }))
    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(BOARD)

    // The board is reached in ONE back press, not two — closing consumed the
    // entry opening added rather than stacking a second board entry on top.
    await back()
    expect(loc()).toBe(STREAM)
  })

  it("closes a deep-linked panel without popping — that entry isn't ours to consume", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, `${BOARD}&panel=conv%3Aa`])

    await user.click(screen.getByRole("button", { name: "close" }))
    // Popping here would have left the app entirely.
    expect(loc()).toBe(BOARD)

    await back()
    expect(loc()).toBe(STREAM)
  })

  it("a superseding open replaces, so back skips the panel it replaced", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("button", { name: "open a" }))
    await user.click(screen.getByRole("button", { name: "supersede with b" }))
    expect(loc()).toBe("/board?lens=all&panel=conv%3Ab")

    // A promoted draft's old id no longer resolves — back must reach the board.
    await back()
    expect(loc()).toBe(BOARD)
  })

  it("pops a panel opened by a <Link>, which never calls openPanel at all", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("link", { name: "link to c" }))
    expect(loc()).toBe("/board?lens=all&panel=conv%3Ac")

    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(BOARD)
    // One press reaches the stream: closing consumed the Link's entry instead of
    // overwriting it and stranding a board entry that reads as a dead back press.
    await back()
    expect(loc()).toBe(STREAM)
  })

  it("clears the panel when closing one opened from inside another, rather than revealing it", async () => {
    const user = userEvent.setup()
    const { loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("button", { name: "open a" }))
    await user.click(screen.getByRole("link", { name: "link to c" }))
    expect(loc()).toBe("/board?lens=all&panel=conv%3Ac")

    // Close means no panel. The affordance reads "Return to #channel" on a nested
    // thread, so popping to the parent panel would land somewhere it doesn't say.
    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(BOARD)
  })

  it("closes a superseding panel by popping — the replaced entry was still ours", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("button", { name: "open a" }))
    await user.click(screen.getByRole("button", { name: "supersede with b" }))
    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(BOARD)

    await back()
    expect(loc()).toBe(STREAM)
  })

  it("drops the overview it opened over, which belonged to the stream underneath", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount(["/s/stream_1?context=links"])

    await user.click(screen.getByRole("button", { name: "open a" }))
    expect(loc()).toBe("/s/stream_1?panel=conv%3Aa")

    // Back returns to the page with its overview still open, as it was left.
    await back()
    expect(loc()).toBe("/s/stream_1?context=links")
  })

  it("drops the open panel's overview when a link inside it opens another panel", async () => {
    const user = userEvent.setup()
    const { loc } = mount(["/s/stream_1?panel=conv%3Aa&context=all"])

    await user.click(screen.getByRole("link", { name: "link to c" }))
    expect(loc()).toBe("/s/stream_1?panel=conv%3Ac")
  })
})

/** Each open tab as the stream page renders it: scoped, with its own close, an
 *  in-place breadcrumb, and its strip link. */
function TabsProbe() {
  const { panelIds, getPanelUrl, getTabUrl } = usePanel()
  const location = useLocation()
  return (
    <div>
      <span data-testid="loc">{decodeURIComponent(`${location.pathname}${location.search}`)}</span>
      <Link to={getPanelUrl("stream_b")}>open b</Link>
      {panelIds.map((id) => (
        <PaneScope key={id} panelId={id}>
          <Link to={getTabUrl(id)} replace>{`tab ${id}`}</Link>
          <ScopedTab />
        </PaneScope>
      ))}
    </div>
  )
}

function ScopedTab() {
  const { panelId, closePanel, getNavigateUrl } = usePanel()
  return (
    <>
      <button onClick={closePanel}>{`close ${panelId}`}</button>
      <Link to={getNavigateUrl("stream_x")}>{`${panelId} to x`}</Link>
    </>
  )
}

const PAGE = "/w/ws/s/stream_main"

describe("panel tabs history", () => {
  const mountTabs = (entries: string[]) => {
    const mounted = mount(entries, <TabsProbe />)
    return { ...mounted, user: userEvent.setup() }
  }

  it("should push a tab and close it on back when a second thread opens", async () => {
    const { user, back, loc } = mountTabs([PAGE, `${PAGE}?panel=stream_a`])

    await user.click(screen.getByRole("link", { name: "open b" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_a.stream_b`)

    await back()
    expect(loc()).toBe(`${PAGE}?panel=stream_a`)
  })

  it("should replace on a tab switch so back skips it", async () => {
    const { user, back, loc } = mountTabs([PAGE, `${PAGE}?panel=stream_a`])

    await user.click(screen.getByRole("link", { name: "open b" }))
    await user.click(screen.getByRole("link", { name: "tab stream_a" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_a*.stream_b`)

    await back()
    expect(loc()).toBe(`${PAGE}?panel=stream_a`)
  })

  it("should pop when the closed tab is the one the entry beneath lacks", async () => {
    const { user, back, loc } = mountTabs([PAGE, `${PAGE}?panel=stream_a`])

    await user.click(screen.getByRole("link", { name: "open b" }))
    await user.click(screen.getByRole("button", { name: "close stream_b" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_a`)

    // One press reaches the bare page: the close consumed the tab's entry.
    await back()
    expect(loc()).toBe(PAGE)
  })

  it("should still pop after a tab switch when the newest tab closes", async () => {
    const { user, back, loc } = mountTabs([PAGE, `${PAGE}?panel=stream_a`])

    await user.click(screen.getByRole("link", { name: "open b" }))
    await user.click(screen.getByRole("link", { name: "tab stream_a" }))
    await user.click(screen.getByRole("button", { name: "close stream_b" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_a`)

    await back()
    expect(loc()).toBe(PAGE)
  })

  it("should replace in place when the closed tab isn't the newest", async () => {
    const { user, back, loc } = mountTabs([PAGE, `${PAGE}?panel=stream_a`])

    await user.click(screen.getByRole("link", { name: "open b" }))
    await user.click(screen.getByRole("button", { name: "close stream_a" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_b`)

    // Back goes where the user was before b opened, a stays reachable.
    await back()
    expect(loc()).toBe(`${PAGE}?panel=stream_a`)
  })

  it("should drop the deep link when the tab it targeted closes", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.stream_b&m=msg_1`])

    await user.click(screen.getByRole("button", { name: "close stream_b" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_a`)
  })

  it("should keep the deep link when a background tab closes", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.stream_b&m=msg_1`])

    await user.click(screen.getByRole("button", { name: "close stream_a" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_b&m=msg_1`)
  })

  it("should drop the deep link when switching tabs", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.stream_b&m=msg_1`])

    await user.click(screen.getByRole("link", { name: "tab stream_a" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_a*.stream_b`)
  })

  it("should navigate a background tab in place without bringing it forward", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.stream_b`])

    await user.click(screen.getByRole("link", { name: "stream_a to x" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_x.stream_b`)
  })

  it("should keep replace-one-panel semantics off the stream page", async () => {
    const { user, loc } = mountTabs(["/w/ws/board?panel=stream_a"])

    await user.click(screen.getByRole("link", { name: "open b" }))
    expect(loc()).toBe("/w/ws/board?panel=stream_b")
  })
})
