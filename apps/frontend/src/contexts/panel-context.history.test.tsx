import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, Link, RouterProvider, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import * as mobile from "@/hooks/use-mobile"
import * as contexts from "@/contexts"
import { StreamPickProvider, useStreamPick } from "@/components/layout/sidebar/stream-pick"
import { navigateAfterShareHandoff } from "@/lib/share-navigation"
import { formatPanelLayout } from "@/lib/panel-tabs"
import { DisplayedPanelLayoutProvider, PanelProvider, PaneScope, useCurrentPane, usePanel } from "./panel-context"

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
  const forward = async () => {
    await act(async () => {
      await router.navigate(1)
    })
  }
  const replaceWith = async (to: string) => {
    await act(async () => {
      await router.navigate(to, { replace: true })
    })
  }
  return { back, forward, replaceWith, loc: () => screen.getByTestId("loc").textContent }
}

const BOARD = "/board?lens=all"
const STREAM = "/s/stream_1"

describe("panel history", () => {
  it("pushes an entry, so back closes the panel instead of leaving the page", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("button", { name: "open a" }))
    expect(loc()).toBe("/board?lens=all&panel=conv:a")

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
    const { back, loc } = mount([STREAM, `${BOARD}&panel=conv:a`])

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
    expect(loc()).toBe("/board?lens=all&panel=conv:b")

    // A promoted draft's old id no longer resolves — back must reach the board.
    await back()
    expect(loc()).toBe(BOARD)
  })

  it("pops a panel opened by a <Link>, which never calls openPanel at all", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("link", { name: "link to c" }))
    expect(loc()).toBe("/board?lens=all&panel=conv:c")

    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(BOARD)
    // One press reaches the stream: closing consumed the Link's entry instead of
    // overwriting it and stranding a board entry that reads as a dead back press.
    await back()
    expect(loc()).toBe(STREAM)
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
})

/** Each open tab as the stream page renders it: scoped, with its own close, an
 *  in-place breadcrumb, and its strip link. */
function TabsProbe() {
  const { layout, getPanelUrl, getTabUrl, setCurrentPane, reopenTab, closeTabs } = usePanel()
  const location = useLocation()
  return (
    <div>
      <span data-testid="loc">{decodeURIComponent(`${location.pathname}${location.search}`)}</span>
      <span data-testid="front">{useCurrentPane()}</span>
      <span data-testid="layout">{formatPanelLayout(layout)}</span>
      <button onClick={() => setCurrentPane("stream_main")}>work in stream_main</button>
      <button onClick={() => setCurrentPane("stream_a")}>work in stream_a</button>
      <button onClick={() => setCurrentPane("stream_b")}>work in stream_b</button>
      <button onClick={() => setCurrentPane("conv:c")}>work in conv:c</button>
      <button onClick={() => setCurrentPane("page:board")}>work in page:board</button>
      <button onClick={() => setCurrentPane("page:persona")}>work in page:persona</button>
      <button onClick={() => reopenTab()}>reopen tab</button>
      <button onClick={() => closeTabs(["stream_a", "conv:c"])}>close stream_a and conv:c</button>
      <button onClick={() => closeTabs(["stream_main", "stream_a", "conv:c"])}>close every tab</button>
      <Link to={getPanelUrl("stream_b")}>open b</Link>
      {layout.columns.flat().flatMap((section) =>
        section.ids.map((id) => (
          <PaneScope key={id} panelId={id} section={section} splits={[]}>
            <Link to={getTabUrl(id)} replace>{`tab ${id}`}</Link>
            <ScopedTab />
          </PaneScope>
        ))
      )}
    </div>
  )
}

function ScopedTab() {
  const { panelId, closePanel, getNavigateUrl, getPanelUrl, getTabUrl, openPanel, setCurrentPane, ownsCover } =
    usePanel()
  const [, setSearchParams] = useSearchParams()
  return (
    <div onPointerDownCapture={() => panelId !== null && setCurrentPane(panelId)}>
      <button onClick={closePanel}>{`close ${panelId}`}</button>
      <Link to={getNavigateUrl("stream_x")}>{`${panelId} to x`}</Link>
      <Link to={getPanelUrl("stream_y")}>{`${panelId} opens y`}</Link>
      <Link to={getPanelUrl(`context:${panelId}`)}>{`${panelId} overview`}</Link>
      {/* A section folded on screen lists tabs of other URL sections. */}
      <Link to={getTabUrl("stream_a")} replace>{`${panelId} shows stream_a`}</Link>
      <button onClick={() => openPanel(`${panelId}_real`, { replace: true })}>{`promote ${panelId}`}</button>
      <button onClick={() => openPanel("stream_t", { replace: true })}>{`${panelId} becomes stream_t`}</button>
      <button
        onClick={() =>
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev)
            next.set("m", "msg_9")
            return next
          })
        }
      >{`${panelId} jumps`}</button>
      {ownsCover && <span>{`${panelId} owns the deep link`}</span>}
    </div>
  )
}

function PickProbe() {
  const pick = useStreamPick()
  return <button onClick={() => pick("stream_a")}>pick stream_a</button>
}

function ShareProbe({ targetStreamId }: { targetStreamId: string }) {
  const panel = usePanel()
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <button
      onClick={() =>
        navigateAfterShareHandoff({ workspaceId: "ws", targetStreamId, location, navigate, isMobile: true, panel })
      }
    >{`share to ${targetStreamId}`}</button>
  )
}

function TabbedProbe() {
  return <span data-testid="tabbed">{usePanel().tabbed ? "tabbed" : "untabbed"}</span>
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
    expect(loc()).toBe("/w/ws/s/stream_b?panel=stream_main-stream_a.stream_b")

    await back()
    expect(loc()).toBe(`${PAGE}?panel=stream_a`)
  })

  it("should replace on a tab switch so back skips it", async () => {
    const { user, back, loc } = mountTabs([PAGE, `${PAGE}?panel=stream_a`])

    await user.click(screen.getByRole("link", { name: "open b" }))
    await user.click(screen.getByRole("link", { name: "tab stream_a" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a*.stream_b")

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
    expect(loc()).toBe("/w/ws/s/stream_b?panel=stream_main-stream_b")

    // Back goes where the user was before b opened, a stays reachable.
    await back()
    expect(loc()).toBe(`${PAGE}?panel=stream_a`)
  })

  it("should reopen the last tab closed beside the page's stream, not over it", async () => {
    const { user, loc } = mountTabs([PAGE, `${PAGE}?panel=stream_a`])

    await user.click(screen.getByRole("button", { name: "close stream_a" }))
    expect(loc()).toBe(PAGE)
    await user.click(screen.getByRole("button", { name: "reopen tab" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a")
  })

  it("should close a batch of tabs in one step, so Back lands where it would after closing one", async () => {
    const { user, back, loc } = mountTabs([PAGE, `${PAGE}?panel=stream_a.stream_b.conv:c`])

    await user.click(screen.getByRole("button", { name: "close stream_a and conv:c" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_b`)

    await back()
    expect(loc()).toBe(PAGE)
  })

  it("should keep the route's stream when a batch closes every tab", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.conv:c`])

    await user.click(screen.getByRole("button", { name: "close every tab" }))
    expect(loc()).toBe(PAGE)
  })

  it("should reopen a batch's tabs latest closed first", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.conv:c`])

    await user.click(screen.getByRole("button", { name: "close stream_a and conv:c" }))
    expect(loc()).toBe(PAGE)
    await user.click(screen.getByRole("button", { name: "reopen tab" }))
    expect(loc()).toBe(`${PAGE}?panel=conv:c`)
    await user.click(screen.getByRole("button", { name: "reopen tab" }))
    expect(screen.getByTestId("layout").textContent).toBe("stream_main-conv:c.stream_a")
  })

  it("should drop the deep link when the tab it targeted closes", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.stream_b&m=msg_1`])

    await user.click(screen.getByRole("button", { name: "close stream_b" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a")
  })

  it("should keep the deep link when a background tab closes", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.stream_b&m=msg_1`])

    await user.click(screen.getByRole("button", { name: "close stream_a" }))
    expect(loc()).toBe("/w/ws/s/stream_b?panel=stream_main-stream_b&m=msg_1")
  })

  it("should drop the deep link when switching tabs", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.stream_b&m=msg_1`])

    await user.click(screen.getByRole("link", { name: "tab stream_a" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a*.stream_b")
  })

  it("should navigate a background tab in place without bringing it forward", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.stream_b`])

    await user.click(screen.getByRole("link", { name: "stream_a to x" }))
    expect(loc()).toBe("/w/ws/s/stream_x?panel=stream_main-stream_x.stream_b")
  })

  it("should keep a tab's deep link while tabs open and close beside it", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_b-stream_a&m=msg_1`])

    await user.click(screen.getByRole("link", { name: "stream_a opens y" }))
    expect(loc()).toBe("/w/ws/s/stream_y?panel=stream_main-stream_b-stream_a-stream_y&m=msg_1")
    await user.click(screen.getByRole("button", { name: "close stream_b" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_a-stream_y&m=msg_1`)
    expect(screen.queryAllByText(/owns the deep link/).map((owner) => owner.textContent)).toEqual([
      "stream_a owns the deep link",
    ])
  })

  it("should drop a tab's deep link when an open covers it", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a-stream_b&m=msg_1`])

    await user.click(screen.getByRole("link", { name: "stream_a to x" }))
    expect(loc()).toBe("/w/ws/s/stream_x?panel=stream_main-stream_x-stream_b&m=msg_1")
    await user.click(screen.getByRole("link", { name: "stream_b to x" }))
    expect(loc()).toBe("/w/ws/s/stream_x?panel=stream_main-stream_x")
  })

  it("should keep a tab's deep link when another section switches tabs", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.stream_c-stream_b&m=msg_1`])

    await user.click(screen.getByRole("link", { name: "tab stream_a" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a*.stream_c-stream_b&m=msg_1")
  })

  it("should give the deep link to the pane that set it", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a-stream_b&m=msg_1`])

    await user.click(screen.getByRole("button", { name: "stream_a jumps" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a-stream_b&m=msg_9")
    expect(screen.queryAllByText(/owns the deep link/).map((owner) => owner.textContent)).toEqual([
      "stream_a owns the deep link",
    ])
  })

  it("should give a restored deep link back to the pane it was set in", async () => {
    const { user, back, loc } = mountTabs([`${PAGE}?panel=stream_a.stream_c`])

    await user.click(screen.getByRole("button", { name: "stream_c jumps" }))
    await user.click(screen.getByRole("link", { name: "open b" }))
    expect(loc()).toBe("/w/ws/s/stream_b?panel=stream_main-stream_a.stream_c-stream_b&m=msg_9")
    await user.click(screen.getByRole("button", { name: "work in stream_main" }))
    await back()
    expect(loc()).toBe("/w/ws/s/stream_c?panel=stream_main-stream_a.stream_c&m=msg_9")
    expect(screen.queryAllByText(/owns the deep link/).map((owner) => owner.textContent)).toEqual([
      "stream_c owns the deep link",
    ])
  })

  it("should close a stream's overview and draft with its tab", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.context:stream_a:links-compose:stream_a.stream_b`])

    await user.click(screen.getByRole("button", { name: "close stream_a" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_b`)
  })

  it("should give a reloaded deep link to the stream an overview lists, not the overview", async () => {
    mountTabs([`${PAGE}?panel=stream_a.context:stream_a&m=msg_1`])
    expect(screen.queryAllByText(/owns the deep link/).map((owner) => owner.textContent)).toEqual([
      "stream_a owns the deep link",
    ])
  })

  it("should give a reloaded deep link to main when the overview lists main", async () => {
    mountTabs([`${PAGE}?panel=context:stream_main&m=msg_1`])
    expect(screen.queryAllByText(/owns the deep link/).map((owner) => owner.textContent)).toEqual([
      "stream_main owns the deep link",
    ])
  })

  it("should not reopen a second overview of a stream that has one open", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a.context:stream_a:links`])

    await user.click(screen.getByRole("button", { name: "close context:stream_a:links" }))
    await user.click(screen.getByRole("link", { name: "stream_a overview" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a-context:stream_a")

    await user.click(screen.getByRole("button", { name: "reopen tab" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a-context:stream_a")
  })

  it("should not count a drawer the screen shows apart as a tab of the page under it", () => {
    const section = { ids: ["stream_a"], active: "stream_a" }
    mount(
      [`${PAGE}?panel=stream_a.context:stream_a`],
      <DisplayedPanelLayoutProvider value={{ columns: [[section]] }}>
        <PaneScope panelId="stream_a" section={section} splits={[]}>
          <TabbedProbe />
        </PaneScope>
      </DisplayedPanelLayoutProvider>
    )
    expect(screen.getByTestId("tabbed").textContent).toBe("untabbed")
  })

  it("should close a stream's overview when another stream takes its tab", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a-context:stream_a`])

    await user.click(screen.getByRole("link", { name: "stream_a to x" }))
    expect(loc()).toBe("/w/ws/s/stream_x?panel=stream_main-stream_x")
  })

  it("should keep a stream under its overview when the overview opens on the board", async () => {
    const { user, back, loc } = mountTabs(["/w/ws/board", "/w/ws/board?panel=stream_a"])

    await user.click(screen.getByRole("link", { name: "stream_a overview" }))
    expect(loc()).toBe("/w/ws/board?panel=stream_a-context:stream_a")
    await user.click(screen.getByRole("button", { name: "close context:stream_a" }))
    expect(loc()).toBe("/w/ws/board?panel=stream_a")

    // The close popped the overview's entry rather than stacking another.
    await back()
    expect(loc()).toBe("/w/ws/board")
  })

  it("should drop the deep link when its pane's row switches to a tab of another section", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a-stream_b&m=msg_1`])

    await user.click(screen.getByRole("link", { name: "stream_b shows stream_a" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a-stream_b")
  })

  it("should not bring a tab forward when it is swapped in place", async () => {
    const { loc } = mountTabs([`${PAGE}?panel=stream_a-stream_b`])

    // A promotion lands on its own, without the user working in that pane.
    fireEvent.click(screen.getByRole("button", { name: "promote stream_a" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_a_real-stream_b`)
    expect(screen.getByTestId("front").textContent).toBe("stream_main")
  })

  it("should hand the route to the next stream pane when the route's own closes", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=stream_a`])

    await user.click(screen.getByRole("button", { name: "close stream_main" }))
    expect(loc()).toBe("/w/ws/s/stream_a")
  })

  it("should land on the pane left, not pop back to the closed stream, when the route's own stream closes", async () => {
    const { user, loc } = mountTabs([PAGE])

    await user.click(screen.getByRole("link", { name: "stream_main overview" }))
    fireEvent.click(screen.getByRole("button", { name: "context:stream_main becomes stream_t" }))
    expect(loc()).toBe("/w/ws/s/stream_t?panel=stream_main-stream_t")
    fireEvent.click(screen.getByRole("button", { name: "close stream_main" }))
    expect(loc()).toBe("/w/ws/s/stream_t")
  })

  it("should keep the last stream pane open", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=context:stream_main`])

    await user.click(screen.getByRole("button", { name: "close stream_main" }))
    expect(loc()).toBe(`${PAGE}?panel=context:stream_main`)
  })

  it("should work in the route's pane when forward reopens a tab beside it", async () => {
    const { back, forward } = mountTabs([
      `${PAGE}?panel=stream_a`,
      "/w/ws/s/stream_a?panel=stream_main-stream_a-stream_b",
    ])

    await back()
    await forward()
    expect(screen.getByTestId("front").textContent).toBe("stream_a")
  })

  it("should keep the route on its stream while working in a pane that isn't one", async () => {
    const { user, loc } = mountTabs([`${PAGE}?panel=conv:c`])

    await user.click(screen.getByRole("button", { name: "conv:c jumps" }))
    expect(loc()).toBe(`${PAGE}?panel=conv:c&m=msg_9`)
    expect(screen.getByTestId("front").textContent).toBe("conv:c")
  })

  it("should open a second panel as a tab beside the board rather than in place of the first", async () => {
    const { user, loc } = mountTabs(["/w/ws/board?panel=stream_a"])

    await user.click(screen.getByRole("link", { name: "open b" }))
    expect(loc()).toBe("/w/ws/board?panel=stream_a.stream_b")
  })

  it("should pin the board in the first column without writing it in the panel param", async () => {
    const { user, loc } = mountTabs(["/w/ws/board?panel=conv:c"])
    expect(screen.getByTestId("layout").textContent).toBe("page:board-conv:c")

    await user.click(screen.getByRole("link", { name: "tab conv:c" }))
    expect(loc()).toBe("/w/ws/board?panel=conv:c")
  })

  it("should drop the board from a panel param that names it", () => {
    mountTabs(["/w/ws/board?panel=page:board.stream_x"])
    expect(screen.getByTestId("layout").textContent).toBe("page:board-stream_x")
  })

  it("should keep only the edited persona's test chat when a persona editor opens", () => {
    mountTabs(["/w/ws/settings/personas/persona_x?panel=test:persona_y.test:persona_x.stream_a"])
    expect(screen.getByTestId("layout").textContent).toBe("page:persona-test:persona_x.stream_a")
  })

  it("should drop persona test chats when the route is not a persona editor", () => {
    mountTabs(["/w/ws/board?panel=test:persona_x.stream_a"])
    expect(screen.getByTestId("layout").textContent).toBe("page:board-stream_a")
  })

  it("should not reopen a persona's test chat away from that persona's editor", async () => {
    const { user, back, loc } = mountTabs([PAGE, "/w/ws/settings/personas/persona_x?panel=test:persona_x"])

    await user.click(screen.getByRole("button", { name: "close test:persona_x" }))
    expect(loc()).toBe("/w/ws/settings/personas/persona_x")
    await back()
    await user.click(screen.getByRole("button", { name: "reopen tab" }))
    expect(loc()).toBe(PAGE)
  })

  it("should land on the bare board when its last pane closes, and never close the board", async () => {
    const { user, back, loc } = mountTabs(["/w/ws/board", "/w/ws/board?panel=conv:c"])

    await user.click(screen.getByRole("button", { name: "close page:board" }))
    expect(loc()).toBe("/w/ws/board?panel=conv:c")
    await user.click(screen.getByRole("button", { name: "close conv:c" }))
    expect(loc()).toBe("/w/ws/board")

    // The close popped the pane's entry rather than stacking another board.
    await back()
    expect(loc()).toBe("/w/ws/board")
  })
})

describe("panel tabs history on a phone", () => {
  beforeEach(() => {
    vi.spyOn(mobile, "useIsMobile").mockReturnValue(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const mountPhone = (entries: string[], probe = <TabsProbe />) => {
    const mounted = mount(entries, probe)
    return { ...mounted, user: userEvent.setup() }
  }
  const front = () => screen.getByTestId("front").textContent

  it("should land on the newest pane when the route's stream isn't written in the panel param", () => {
    mountPhone([`${PAGE}?panel=stream_a.stream_b`])
    expect(front()).toBe("stream_b")
  })

  it("should land on the route's stream when the panel param writes it", () => {
    mountPhone([`${PAGE}?panel=stream_main-stream_a.stream_b`])
    expect(front()).toBe("stream_main")
  })

  it("should write the route's stream when a swipe brings it to the front, so a reload lands on it", async () => {
    const { user, loc } = mountPhone([`${PAGE}?panel=stream_a.stream_b`])

    await user.click(screen.getByRole("button", { name: "work in stream_main" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_main-stream_a.stream_b`)
    expect(front()).toBe("stream_main")
  })

  it("should name the pane a swipe leaves the route's stream for, with the stream written out", async () => {
    const { user, loc } = mountPhone([`${PAGE}?panel=stream_main-stream_a.stream_b`])

    await user.click(screen.getByRole("button", { name: "work in stream_b" }))
    expect(loc()).toBe("/w/ws/s/stream_b?panel=stream_main-stream_a.stream_b")
    expect(front()).toBe("stream_b")
  })

  it("should bring the pane behind in its section on show when a swipe reaches it from a link that doesn't write the route's stream", async () => {
    const { user, loc } = mountPhone([`${PAGE}?panel=stream_a.stream_b`])

    await user.click(screen.getByRole("button", { name: "work in stream_a" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a*.stream_b")
    expect(front()).toBe("stream_a")
  })

  it("should stop writing the route's stream when a swipe leaves it for a pane that isn't a stream", async () => {
    const { user, loc } = mountPhone([`${PAGE}?panel=stream_main-conv:c`])

    await user.click(screen.getByRole("button", { name: "work in conv:c" }))
    expect(loc()).toBe(`${PAGE}?panel=conv:c`)
    expect(front()).toBe("conv:c")
  })

  it("should write the board when a switch brings it in front, so a reload lands on it", async () => {
    const { user, loc } = mountPhone(["/w/ws/board?panel=conv:c"])
    expect(front()).toBe("conv:c")

    await user.click(screen.getByRole("button", { name: "work in page:board" }))
    expect({ loc: loc(), front: front() }).toEqual({ loc: "/w/ws/board?panel=page:board-conv:c", front: "page:board" })

    cleanup()
    mountPhone(["/w/ws/board?panel=page:board-conv:c"])
    expect(front()).toBe("page:board")
  })

  it("should stop writing the board when a switch leaves it", async () => {
    const { user, loc } = mountPhone(["/w/ws/board?panel=page:board-conv:c"])

    await user.click(screen.getByRole("button", { name: "work in conv:c" }))
    expect({ loc: loc(), front: front() }).toEqual({ loc: "/w/ws/board?panel=conv:c", front: "conv:c" })
  })

  it("should keep the board written while it stays in front of a pane closing behind it", async () => {
    const { loc } = mountPhone(["/w/ws/board?panel=page:board-conv:c-stream_a"])
    expect(front()).toBe("page:board")

    // A click without a pointer down, which would bring the closing pane in front first.
    fireEvent.click(screen.getByRole("button", { name: "close stream_a" }))
    expect(loc()).toBe("/w/ws/board?panel=page:board-conv:c")
    fireEvent.click(screen.getByRole("button", { name: "close conv:c" }))
    expect(loc()).toBe("/w/ws/board")
  })

  it("should write the persona editor when a switch brings it in front of its test chat", async () => {
    const { user, loc } = mountPhone(["/w/ws/settings/personas/persona_x?panel=test:persona_x"])
    expect(front()).toBe("test:persona_x")

    await user.click(screen.getByRole("button", { name: "work in page:persona" }))
    expect(loc()).toBe("/w/ws/settings/personas/persona_x?panel=page:persona-test:persona_x")
    expect(front()).toBe("page:persona")
  })

  it("should put the route's stream in front when Back restores an entry that writes it", async () => {
    const { back } = mountPhone([`${PAGE}?panel=stream_main-stream_a.stream_b`, `${PAGE}?panel=stream_a.stream_b`])
    expect(front()).toBe("stream_b")

    await back()
    expect(front()).toBe("stream_main")
  })

  it("should land a reload on a pane that isn't a stream when it is the newest, wherever the route's stream sits", async () => {
    const { user, loc } = mountPhone([`/w/ws/s/stream_b?panel=stream_main-stream_b-conv:c`])
    expect(front()).toBe("stream_b")

    await user.click(screen.getByRole("button", { name: "work in conv:c" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_b-conv:c`)

    cleanup()
    mountPhone([`${PAGE}?panel=stream_b-conv:c`])
    expect(front()).toBe("conv:c")
  })

  it("should land Back where a reload of the entry lands when the entry doesn't write the route's stream", async () => {
    const { back } = mountPhone([
      `${PAGE}?panel=stream_a.stream_b`,
      `/w/ws/s/stream_a?panel=stream_main-stream_a*.stream_b`,
    ])
    expect(front()).toBe("stream_a")

    await back()
    expect(front()).toBe("stream_b")
  })

  it("should give a reloaded deep link to the pane a reload lands on", () => {
    mountPhone([`${PAGE}?panel=stream_main-stream_t&m=msg_1`])
    expect({
      front: front(),
      main: screen.queryByText("stream_main owns the deep link") !== null,
      t: screen.queryByText("stream_t owns the deep link") !== null,
    }).toEqual({ front: "stream_main", main: true, t: false })
  })

  it("should pop back to the pane that isn't a stream when a stream tab opened from it closes", async () => {
    const { user, back, loc } = mountPhone([PAGE, `${PAGE}?panel=stream_b-conv:c`])
    expect(front()).toBe("conv:c")

    await user.click(screen.getByRole("link", { name: "conv:c opens y" }))
    expect(front()).toBe("stream_y")
    await user.click(screen.getByRole("button", { name: "close stream_y" }))
    expect({ loc: loc(), front: front() }).toEqual({ loc: `${PAGE}?panel=stream_b-conv:c`, front: "conv:c" })

    await back()
    expect(loc()).toBe(PAGE)
  })

  it("should leave the entry before a sidebar pick of the route's stream for Back", async () => {
    vi.spyOn(contexts, "useSidebar").mockReturnValue({ isMobile: true } as ReturnType<typeof contexts.useSidebar>)
    const before = "/w/ws/s/stream_a?panel=stream_main-stream_a.stream_b"
    const { user, back, loc } = mountPhone(
      ["/w/ws/board", before],
      <StreamPickProvider workspaceId="ws">
        <TabsProbe />
        <PickProbe />
      </StreamPickProvider>
    )

    await user.click(screen.getByRole("button", { name: "pick stream_a" }))
    expect(loc()).toBe("/w/ws/s/stream_a?panel=stream_main-stream_a*.stream_b")

    await back()
    expect(loc()).toBe(before)
  })

  it("should bring a share target already among the panes to the front in place", async () => {
    const { user, back, loc } = mountPhone(
      [PAGE, `${PAGE}?panel=stream_t`],
      <>
        <TabsProbe />
        <ShareProbe targetStreamId="stream_main" />
      </>
    )
    expect(front()).toBe("stream_t")

    await user.click(screen.getByRole("button", { name: "share to stream_main" }))
    expect({ loc: loc(), front: front() }).toEqual({ loc: `${PAGE}?panel=stream_main-stream_t`, front: "stream_main" })

    await back()
    expect(loc()).toBe(PAGE)
  })

  it("should open a share target outside the panes as a page of its own", async () => {
    const { user, back, loc } = mountPhone(
      [PAGE, `${PAGE}?panel=stream_t`],
      <>
        <TabsProbe />
        <ShareProbe targetStreamId="stream_z" />
      </>
    )

    await user.click(screen.getByRole("button", { name: "share to stream_z" }))
    expect(loc()).toBe("/w/ws/s/stream_z")

    await back()
    expect(loc()).toBe(`${PAGE}?panel=stream_t`)
  })

  it("should write the pane a switch beside the board brings on show, without moving the route", async () => {
    const { user, loc } = mountPhone(["/w/ws/board?panel=conv:c.stream_b"])
    expect(front()).toBe("stream_b")

    await user.click(screen.getByRole("button", { name: "work in conv:c" }))
    expect({ loc: loc(), front: front() }).toEqual({ loc: "/w/ws/board?panel=conv:c*.stream_b", front: "conv:c" })
  })

  it("should keep the route's stream unwritten on a desktop", async () => {
    vi.mocked(mobile.useIsMobile).mockReturnValue(false)
    const { user, loc } = mountPhone([`${PAGE}?panel=stream_a.stream_b`])

    await user.click(screen.getByRole("button", { name: "work in stream_main" }))
    expect(loc()).toBe(`${PAGE}?panel=stream_a.stream_b`)
  })
})
