import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useState } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import * as mobileModule from "@/hooks/use-mobile"
import { Drawer, DrawerContent, DrawerTitle } from "./drawer"

afterEach(() => vi.restoreAllMocks())

function DrawerHarness() {
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
  return createMemoryRouter(
    [
      { path: "/other", element: <div>other-page</div> },
      { path: STREAM_PATH, element: ui },
    ],
    { initialEntries: ["/other", STREAM_PATH], initialIndex: 1 }
  )
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

  it("survives a forward navigation and closes on the back that pops its sentinel", async () => {
    const router = makeRouter(<DrawerHarness />)
    render(<RouterProvider router={router} />)

    await openDrawer(router)

    // A forward push (drawer stacking, in-page navigation) must not close it
    await act(async () => {
      await router.navigate(`${STREAM_PATH}?x=1`)
    })
    expect(screen.getByText("drawer-open")).toBeInTheDocument()

    // Back onto the sentinel: still open — the sentinel is current again
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.search).toBe(""))
    expect(screen.getByText("drawer-open")).toBeInTheDocument()

    // Back past the sentinel closes the drawer without leaving the page
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
    await openDrawer(router, "open-b")

    await act(async () => {
      await router.navigate(-1)
    })

    await waitFor(() => expect(screen.getByText("b-closed")).toBeInTheDocument())
    expect(screen.getByText("a-open")).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(STREAM_PATH)
  })

  it("closing a stack in one tick unwinds both sentinel entries", async () => {
    const router = makeRouter(<StackedHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    await openDrawer(router, "open-a")
    await openDrawer(router, "open-b")

    fireEvent.click(screen.getByText("close-both"))

    await waitFor(() => expect(router.state.location.key).toBe(initialKey))
    expect(screen.getByText("a-closed")).toBeInTheDocument()
    expect(screen.getByText("b-closed")).toBeInTheDocument()
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

describe("HistoryBackClose outside a router", () => {
  it("drawer works without a router context", async () => {
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(true)
    render(<DrawerHarness />)

    fireEvent.click(screen.getByText("open-drawer"))
    expect(await screen.findByText("drawer-open")).toBeInTheDocument()

    fireEvent.click(screen.getByText("close-drawer"))
    expect(await screen.findByText("drawer-closed")).toBeInTheDocument()
  })
})
