import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useState } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createMemoryRouter, Link, RouterProvider } from "react-router-dom"
import * as mobileModule from "@/hooks/use-mobile"
import { __resetOverlayHistoryForTests, attachOverlayHistoryRouter, OverlayHistoryLayout } from "./history-back-close"
import { Drawer, DrawerContent, DrawerTitle } from "./drawer"

afterEach(() => {
  vi.restoreAllMocks()
  __resetOverlayHistoryForTests()
})

function DrawerHarness() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <span>{open ? "drawer-open" : "drawer-closed"}</span>
      <button onClick={() => setOpen(true)}>open-drawer</button>
      <button onClick={() => setOpen(false)}>close-drawer</button>
      {/* A sidebar-style stream link: closes the overlay and pushes, one tick */}
      <Link to="/other" onClick={() => setOpen(false)}>
        navigate-item
      </Link>
      {/* A settings-style item: closes the overlay and replace-navigates */}
      <Link to={`${STREAM_PATH}?settings=profile`} replace onClick={() => setOpen(false)}>
        settings-item
      </Link>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerTitle>Menu</DrawerTitle>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

/**
 * Two drawers with a same-tick handoff, mirroring the sidebar footer's
 * account-drawer → status-picker flow (`openStatus` closes the drawer and
 * opens the dialog in one click handler).
 */
function StackedHarness() {
  const [aOpen, setAOpen] = useState(false)
  const [bOpen, setBOpen] = useState(false)
  return (
    <div>
      <span>{aOpen ? "a-open" : "a-closed"}</span>
      <span>{bOpen ? "b-open" : "b-closed"}</span>
      <button onClick={() => setAOpen(true)}>open-a</button>
      <button onClick={() => setBOpen(true)}>open-b</button>
      <button
        onClick={() => {
          setAOpen(false)
          setBOpen(true)
        }}
      >
        handoff-a-to-b
      </button>
      <button
        onClick={() => {
          setAOpen(false)
          setBOpen(false)
        }}
      >
        close-both
      </button>
      <Drawer open={aOpen} onOpenChange={setAOpen}>
        <DrawerContent>
          <DrawerTitle>A</DrawerTitle>
        </DrawerContent>
      </Drawer>
      <Drawer open={bOpen} onOpenChange={setBOpen}>
        <DrawerContent>
          <DrawerTitle>B</DrawerTitle>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

const STREAM_PATH = "/w/ws1/s/stream1"

function makeRouter(ui: React.ReactElement) {
  // Same shape as production: the coordinator's location feed is a pathless
  // layout wrapping every route, and the router itself is attached.
  const router = createMemoryRouter(
    [
      {
        element: <OverlayHistoryLayout />,
        children: [
          { path: "/other", element: <div>other-page</div> },
          { path: STREAM_PATH, element: ui },
        ],
      },
    ],
    { initialEntries: ["/other", STREAM_PATH], initialIndex: 1 }
  )
  attachOverlayHistoryRouter(router)
  return router
}

async function openDrawer(router: ReturnType<typeof makeRouter>, name = "open-drawer") {
  const keyBefore = router.state.location.key
  fireEvent.click(screen.getByText(name))
  // The sentinel entry lands asynchronously
  await waitFor(() => expect(router.state.location.key).not.toBe(keyBefore))
}

describe("HistoryBackClose via Drawer (mobile)", () => {
  beforeEach(() => {
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(true)
  })

  it("back gesture closes the drawer and stays on the page", async () => {
    const router = makeRouter(<DrawerHarness />)
    render(<RouterProvider router={router} />)

    await openDrawer(router)
    expect(router.state.location.pathname).toBe(STREAM_PATH)

    await act(async () => {
      await router.navigate(-1)
    })

    await waitFor(() => expect(screen.getByText("drawer-closed")).toBeInTheDocument())
    expect(router.state.location.pathname).toBe(STREAM_PATH)
  })

  it("closing via UI pops the sentinel entry so back leaves the page", async () => {
    const router = makeRouter(<DrawerHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    await openDrawer(router)
    fireEvent.click(screen.getByText("close-drawer"))

    await waitFor(() => expect(router.state.location.key).toBe(initialKey))

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"))
  })

  it("survives a forward navigation and closes on the next back, in place", async () => {
    const router = makeRouter(<DrawerHarness />)
    render(<RouterProvider router={router} />)

    await openDrawer(router)

    // A forward push must not close the drawer; the coordinator re-establishes
    // the sentinel at the new location.
    await act(async () => {
      await router.navigate(`${STREAM_PATH}?x=1`)
    })
    expect(screen.getByText("drawer-open")).toBeInTheDocument()

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("drawer-closed")).toBeInTheDocument())
    expect(router.state.location.pathname).toBe(STREAM_PATH)
  })

  it("back closes only the top drawer of a stack", async () => {
    const router = makeRouter(<StackedHarness />)
    render(<RouterProvider router={router} />)

    await openDrawer(router, "open-a")
    fireEvent.click(screen.getByText("open-b"))
    await waitFor(() => expect(screen.getByText("b-open")).toBeInTheDocument())

    await act(async () => {
      await router.navigate(-1)
    })

    await waitFor(() => expect(screen.getByText("b-closed")).toBeInTheDocument())
    expect(screen.getByText("a-open")).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(STREAM_PATH)

    // Second back peels the remaining drawer, still without leaving the page
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("a-closed")).toBeInTheDocument())
    expect(router.state.location.pathname).toBe(STREAM_PATH)
  })

  it("closing a stack in one tick unwinds the sentinel", async () => {
    const router = makeRouter(<StackedHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    await openDrawer(router, "open-a")
    fireEvent.click(screen.getByText("open-b"))
    await waitFor(() => expect(screen.getByText("b-open")).toBeInTheDocument())

    fireEvent.click(screen.getByText("close-both"))

    await waitFor(() => expect(router.state.location.key).toBe(initialKey))
    expect(screen.getByText("a-closed")).toBeInTheDocument()
    expect(screen.getByText("b-closed")).toBeInTheDocument()
  })

  it("a menu item that closes the drawer and pushes a route actually navigates", async () => {
    const router = makeRouter(<DrawerHarness />)
    render(<RouterProvider router={router} />)

    await openDrawer(router)
    fireEvent.click(screen.getByText("navigate-item"))

    // The navigation must survive the sentinel cleanup — not get popped away
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"))
    await act(async () => {})
    expect(router.state.location.pathname).toBe("/other")
  })

  it("a menu item that closes the drawer and replace-navigates keeps its target", async () => {
    const router = makeRouter(<DrawerHarness />)
    render(<RouterProvider router={router} />)

    await openDrawer(router)
    fireEvent.click(screen.getByText("settings-item"))

    await waitFor(() => expect(router.state.location.search).toBe("?settings=profile"))
    await act(async () => {})
    expect(router.state.location.search).toBe("?settings=profile")
    await waitFor(() => expect(screen.getByText("drawer-closed")).toBeInTheDocument())
  })

  it("same-tick handoff (close A, open B) keeps back working for B", async () => {
    const router = makeRouter(<StackedHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    await openDrawer(router, "open-a")
    fireEvent.click(screen.getByText("handoff-a-to-b"))
    await waitFor(() => expect(screen.getByText("b-open")).toBeInTheDocument())
    expect(screen.getByText("a-closed")).toBeInTheDocument()

    // Let any serialized pop/push settle, then back must close B in place
    await act(async () => {})
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("b-closed")).toBeInTheDocument())
    expect(router.state.location.pathname).toBe(STREAM_PATH)

    // History is balanced: the next back leaves the page
    await waitFor(() => expect(router.state.location.key).toBe(initialKey))
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"))
  })
})

describe("HistoryBackClose via Drawer (desktop)", () => {
  it("opening pushes nothing; back navigates away", async () => {
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(false)
    const router = makeRouter(<DrawerHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    fireEvent.click(screen.getByText("open-drawer"))
    expect(await screen.findByText("drawer-open")).toBeInTheDocument()
    // Flush any pending navigation before asserting none happened
    await act(async () => {})
    expect(router.state.location.key).toBe(initialKey)

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"))
  })
})

// DrawerHarness calls useNavigate, so the no-router test needs a router-free twin.
function RouterlessDrawerHarness() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <span>{open ? "drawer-open" : "drawer-closed"}</span>
      <button onClick={() => setOpen(true)}>open-drawer</button>
      <button onClick={() => setOpen(false)}>close-drawer</button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerTitle>Menu</DrawerTitle>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

describe("HistoryBackClose outside a router", () => {
  it("drawer works without a router context", async () => {
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(true)
    render(<RouterlessDrawerHarness />)

    fireEvent.click(screen.getByText("open-drawer"))
    expect(await screen.findByText("drawer-open")).toBeInTheDocument()

    fireEvent.click(screen.getByText("close-drawer"))
    expect(await screen.findByText("drawer-closed")).toBeInTheDocument()
  })
})
