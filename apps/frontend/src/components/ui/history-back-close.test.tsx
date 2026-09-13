import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useState } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createMemoryRouter, Link, RouterProvider } from "react-router-dom"
import * as mobileModule from "@/hooks/use-mobile"
import { __resetOverlayHistoryForTests, attachOverlayHistoryRouter } from "./history-back-close"
import { Drawer, DrawerContent, DrawerTitle } from "./drawer"
import { Dialog, DialogContent, DialogTitle } from "./dialog"
import { MediaGalleryProvider, useMediaGallery } from "@/contexts/media-gallery-context"
import { CodeViewerProvider, useCodeViewerOptional } from "@/contexts/code-viewer-context"
import * as highlighterModule from "@/lib/markdown/highlighter"

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
      {/* An actions-drawer item: closes B and pushes a same-page URL entry */}
      <Link to={`${STREAM_PATH}?panel=1`} onClick={() => setBOpen(false)}>
        reply-item
      </Link>
      {/* Both overlays close in the commit that pushes (a page change unmounting them) */}
      <Link
        to={`${STREAM_PATH}?panel=1`}
        onClick={() => {
          setAOpen(false)
          setBOpen(false)
        }}
      >
        leave-both
      </Link>
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
  // Same shape as production: a pathless layout wrapping every route, and the
  // router attached — its own subscription is the coordinator's location feed.
  const router = createMemoryRouter(
    [
      {
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

/** Every PUSH the router commits from now on, whoever issued it, by where it landed. */
function countPushes(router: ReturnType<typeof makeRouter>) {
  const pushes = { count: 0, urls: [] as string[] }
  router.subscribe((state) => {
    if (state.historyAction !== "PUSH") return
    pushes.count += 1
    pushes.urls.push(state.location.pathname + state.location.search)
  })
  return pushes
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

  it("survives a forward navigation: back returns to the drawer's entry, the next back closes it", async () => {
    const router = makeRouter(<DrawerHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    await openDrawer(router)
    const drawerKey = router.state.location.key
    const pushes = countPushes(router)

    // A forward push must not close the drawer, and the coordinator must not
    // stack a second entry over it — the phone's aside sheet is exactly this:
    // a `?panel=` entry pushed while the sheet's entry sits below.
    await act(async () => {
      await router.navigate(`${STREAM_PATH}?x=1`)
    })
    await act(async () => {})
    expect(screen.getByText("drawer-open")).toBeInTheDocument()
    expect(pushes.count).toBe(1)

    // Back lands on the entry the drawer was opened on, drawer still open, and
    // the coordinator pushes NOTHING after it: Chrome marks every entry
    // skippable when a pushState follows a back without a user gesture between
    // them, and Android's next back then leaves the app.
    await act(async () => {
      await router.navigate(-1)
    })
    await act(async () => {})
    expect(router.state.location.key).toBe(drawerKey)
    expect(screen.getByText("drawer-open")).toBeInTheDocument()
    expect(pushes.count).toBe(1)

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("drawer-closed")).toBeInTheDocument())
    expect(router.state.location.key).toBe(initialKey)
    expect(pushes.count).toBe(1)
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

  it("an entry left behind by a drawer that closed while pushing is popped on landing, never re-pushed", async () => {
    const router = makeRouter(<StackedHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    // The phone's shape: the aside sheet (A) holds its entry, the message
    // actions drawer (B) opens over it, and its "Reply in thread" link closes
    // B while pushing `?panel=` — B's entry stays under the panel's.
    await openDrawer(router, "open-a")
    const aKey = router.state.location.key
    fireEvent.click(screen.getByText("open-b"))
    await waitFor(() => expect(router.state.location.key).not.toBe(aKey))
    fireEvent.click(screen.getByText("reply-item"))
    await waitFor(() => expect(router.state.location.search).toBe("?panel=1"))
    await act(async () => {})
    expect(screen.getByText("b-closed")).toBeInTheDocument()
    expect(screen.getByText("a-open")).toBeInTheDocument()
    const pushes = countPushes(router)

    // One back closes the panel and settles on A's entry with A still open,
    // consuming B's stale entry by a pop — a push here is what makes Android's
    // next back leave the app.
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.key).toBe(aKey))
    expect(screen.getByText("a-open")).toBeInTheDocument()
    expect(router.state.location.search).toBe("")
    expect(pushes.count).toBe(0)

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("a-closed")).toBeInTheDocument())
    expect(router.state.location.key).toBe(initialKey)
    expect(pushes.count).toBe(0)
  })

  it("an overlay opened over a left-behind entry gets an entry of its own", async () => {
    const router = makeRouter(<StackedHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    // A holds its entry, B's item pushes `?panel=` and closes B; in the panel
    // the reader opens B again (a long-press on a thread message).
    await openDrawer(router, "open-a")
    const aKey = router.state.location.key
    fireEvent.click(screen.getByText("open-b"))
    await waitFor(() => expect(router.state.location.key).not.toBe(aKey))
    fireEvent.click(screen.getByText("reply-item"))
    await waitFor(() => expect(router.state.location.search).toBe("?panel=1"))
    await act(async () => {})
    const panelKey = router.state.location.key
    const pushes = countPushes(router)

    // B's old entry is stale, not a stand-in: the reopened B pushes its own,
    // else the first back would close the panel by URL and leave B floating.
    await openDrawer(router, "open-b")
    expect(pushes.urls).toEqual([`${STREAM_PATH}?panel=1`])

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("b-closed")).toBeInTheDocument())
    expect(router.state.location.key).toBe(panelKey)
    expect(screen.getByText("a-open")).toBeInTheDocument()

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.key).toBe(aKey))
    expect(screen.getByText("a-open")).toBeInTheDocument()

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("a-closed")).toBeInTheDocument())
    expect(router.state.location.key).toBe(initialKey)
    expect(pushes.count).toBe(1)
  })

  it("two overlays closing under one push both leave stale entries", async () => {
    const router = makeRouter(<StackedHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    await openDrawer(router, "open-a")
    const aKey = router.state.location.key
    fireEvent.click(screen.getByText("open-b"))
    await waitFor(() => expect(router.state.location.key).not.toBe(aKey))
    fireEvent.click(screen.getByText("leave-both"))
    await waitFor(() => expect(router.state.location.search).toBe("?panel=1"))
    await act(async () => {})
    const pushes = countPushes(router)

    // Neither left-behind entry stands in for the next overlay.
    await openDrawer(router, "open-a")
    expect(pushes.urls).toEqual([`${STREAM_PATH}?panel=1`])

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("a-closed")).toBeInTheDocument())
    expect(router.state.location.search).toBe("?panel=1")

    // Both stale entries go by pops: the back lands on B's, its pop lands on
    // A's, and that pop lands where the reader was before either opened.
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.key).toBe(initialKey))
    expect(pushes.count).toBe(1)
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

  it("back onto an entry left behind on another page pops it, never pushes", async () => {
    const router = makeRouter(<DrawerHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    await openDrawer(router)
    fireEvent.click(screen.getByText("navigate-item"))
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"))
    await act(async () => {})
    const pushes = countPushes(router)

    // The entry the drawer left behind stands in for nothing: a back lands on
    // it and it goes by a pop, so the reader is where they were before the
    // drawer opened and nothing was pushed after the back.
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.key).toBe(initialKey))
    expect(router.state.location.pathname).toBe(STREAM_PATH)
    expect(pushes.count).toBe(0)
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

/** A dialog-based overlay (the media gallery's shape: controlled, full-screen). */
function DialogHarness() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <span>{open ? "dialog-open" : "dialog-closed"}</span>
      <button onClick={() => setOpen(true)}>open-dialog</button>
      <button onClick={() => setOpen(false)}>close-dialog</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Preview</DialogTitle>
        </DialogContent>
      </Dialog>
    </div>
  )
}

describe("HistoryBackClose via Dialog (mobile)", () => {
  beforeEach(() => {
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(true)
  })

  it("back gesture closes the dialog and stays on the page", async () => {
    const router = makeRouter(<DialogHarness />)
    render(<RouterProvider router={router} />)

    await openDrawer(router, "open-dialog")

    await act(async () => {
      await router.navigate(-1)
    })

    await waitFor(() => expect(screen.getByText("dialog-closed")).toBeInTheDocument())
    expect(router.state.location.pathname).toBe(STREAM_PATH)
  })

  it("closing via UI pops the sentinel entry so back leaves the page", async () => {
    const router = makeRouter(<DialogHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    await openDrawer(router, "open-dialog")
    fireEvent.click(screen.getByText("close-dialog"))

    await waitFor(() => expect(router.state.location.key).toBe(initialKey))

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"))
  })
})

describe("HistoryBackClose via Dialog (desktop)", () => {
  beforeEach(() => {
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(false)
  })

  it("takes an entry like on mobile: back closes it and stays, UI close pops it", async () => {
    const router = makeRouter(<DialogHarness />)
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    await openDrawer(router, "open-dialog")
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("dialog-closed")).toBeInTheDocument())
    expect(router.state.location.pathname).toBe(STREAM_PATH)

    await openDrawer(router, "open-dialog")
    fireEvent.click(screen.getByText("close-dialog"))
    await waitFor(() => expect(router.state.location.key).toBe(initialKey))
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"))
  })
})

/**
 * The media gallery deepens history itself (`?media=`) and pops that entry on
 * close, so its dialog takes no sentinel: one entry per open, one back press
 * or one close to land on the bare stream.
 */
function GalleryHarness() {
  const { mediaAttachmentId, openMedia, closeMedia } = useMediaGallery()
  const open = mediaAttachmentId !== null
  return (
    <div>
      <span>{open ? "gallery-open" : "gallery-closed"}</span>
      <button onClick={() => openMedia("attach_1")}>open-gallery</button>
      <button onClick={() => openMedia("attach_2")}>next-item</button>
      <button onClick={closeMedia}>close-gallery</button>
      <Dialog open={open} onOpenChange={(next) => !next && closeMedia()} historyEntry={false}>
        <DialogContent>
          <DialogTitle>Media</DialogTitle>
        </DialogContent>
      </Dialog>
    </div>
  )
}

describe.each([
  ["mobile", true],
  ["desktop", false],
])("HistoryBackClose with the URL-driven media gallery (%s)", (_, isMobile) => {
  beforeEach(() => {
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(isMobile)
  })

  it("closing via the gallery's own control pops its entry so the next back leaves the page", async () => {
    const router = makeRouter(
      <MediaGalleryProvider>
        <GalleryHarness />
      </MediaGalleryProvider>
    )
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    fireEvent.click(screen.getByText("open-gallery"))
    await waitFor(() => expect(router.state.location.search).toBe("?media=attach_1"))
    await act(async () => {})

    fireEvent.click(screen.getByText("close-gallery"))
    await waitFor(() => expect(screen.getByText("gallery-closed")).toBeInTheDocument())
    await waitFor(() => expect(router.state.location.key).toBe(initialKey))

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"))
  })

  it("one back press closes the gallery, clears ?media= and stays on the page", async () => {
    const router = makeRouter(
      <MediaGalleryProvider>
        <GalleryHarness />
      </MediaGalleryProvider>
    )
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    fireEvent.click(screen.getByText("open-gallery"))
    await waitFor(() => expect(screen.getByText("gallery-open")).toBeInTheDocument())
    // Both the ?media= entry and the sentinel have landed
    await waitFor(() => expect(router.state.location.search).toBe("?media=attach_1"))
    await act(async () => {})

    await act(async () => {
      await router.navigate(-1)
    })

    await waitFor(() => expect(screen.getByText("gallery-closed")).toBeInTheDocument())
    await waitFor(() => expect(router.state.location.key).toBe(initialKey))
    expect(router.state.location.pathname).toBe(STREAM_PATH)
    expect(router.state.location.search).toBe("")

    // History is balanced: the next back leaves the page
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"))
  })
  it("swiping to the next item replaces our entry in place: one back still closes, nothing pushed", async () => {
    const router = makeRouter(
      <MediaGalleryProvider>
        <GalleryHarness />
      </MediaGalleryProvider>
    )
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    fireEvent.click(screen.getByText("open-gallery"))
    await waitFor(() => expect(router.state.location.search).toBe("?media=attach_1"))
    await act(async () => {})
    const pushes = countPushes(router)

    // The gallery replace-navigates between items, and the entry on top is
    // ours. Forgetting it here meant a fresh push per swipe, and a back that
    // landed on `?media=` reopened the gallery and pushed again.
    fireEvent.click(screen.getByText("next-item"))
    await waitFor(() => expect(router.state.location.search).toBe("?media=attach_2"))
    await act(async () => {})
    expect(pushes.count).toBe(0)

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("gallery-closed")).toBeInTheDocument())
    await waitFor(() => expect(router.state.location.key).toBe(initialKey))
    expect(pushes.count).toBe(0)

    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"))
  })
})

/**
 * The real two-overlay stack this feature introduces: a markdown attachment
 * open in the gallery (`?media=`, which deepens history itself) with a code
 * block inside it opened full screen on top. One back press must peel exactly
 * one overlay.
 */
function GalleryWithCodeViewerHarness() {
  const { mediaAttachmentId, openMedia, closeMedia } = useMediaGallery()
  const codeViewer = useCodeViewerOptional()
  const open = mediaAttachmentId !== null
  return (
    <div>
      <span>{open ? "gallery-open" : "gallery-closed"}</span>
      <button onClick={() => openMedia("attach_1")}>open-gallery</button>
      <Dialog open={open} onOpenChange={(next) => !next && closeMedia()} historyEntry={false}>
        <DialogContent>
          <DialogTitle>Media</DialogTitle>
          <button onClick={() => codeViewer?.open({ code: "const a = 1", languageId: "typescript" })}>
            open-code-viewer
          </button>
        </DialogContent>
      </Dialog>
    </div>
  )
}

describe("HistoryBackClose with the code viewer stacked over the gallery (mobile)", () => {
  beforeEach(() => {
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(true)
    // Deterministic first paint: the shiki singleton is unwarmed in jsdom, so
    // the viewer would otherwise swap in highlighted HTML mid-assertion.
    vi.spyOn(highlighterModule, "tryHighlightSync").mockReturnValue("<pre><code>const a = 1</code></pre>")
  })

  it("peels one overlay per back press: viewer first, then the gallery", async () => {
    const router = makeRouter(
      <MediaGalleryProvider>
        <CodeViewerProvider>
          <GalleryWithCodeViewerHarness />
        </CodeViewerProvider>
      </MediaGalleryProvider>
    )
    render(<RouterProvider router={router} />)
    const initialKey = router.state.location.key

    fireEvent.click(screen.getByText("open-gallery"))
    await waitFor(() => expect(screen.getByText("gallery-open")).toBeInTheDocument())
    await waitFor(() => expect(router.state.location.search).toBe("?media=attach_1"))
    await act(async () => {})

    fireEvent.click(screen.getByText("open-code-viewer"))
    await waitFor(() => expect(screen.getByRole("button", { name: "Wrap lines" })).toBeInTheDocument())
    await act(async () => {})
    const pushes = countPushes(router)

    // First back: the viewer goes, the gallery stays open on ?media=, and
    // nothing is pushed after the back (the viewer had its own entry)
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.queryByRole("button", { name: "Wrap lines" })).not.toBeInTheDocument())
    expect(screen.getByText("gallery-open")).toBeInTheDocument()
    expect(router.state.location.search).toBe("?media=attach_1")
    expect(pushes.count).toBe(0)

    // Second back: the gallery goes, and we are back where we started
    await act(async () => {
      await router.navigate(-1)
    })
    await waitFor(() => expect(screen.getByText("gallery-closed")).toBeInTheDocument())
    await waitFor(() => expect(router.state.location.key).toBe(initialKey))
    expect(router.state.location.search).toBe("")

    // History is balanced: the next back leaves the page
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
