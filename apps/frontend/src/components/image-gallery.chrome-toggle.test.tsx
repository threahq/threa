import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { MediaGalleryProvider } from "@/contexts"
import { attachmentsApi } from "@/api"
import { AttachmentList } from "@/components/timeline/attachment-list"
import * as useMobileModule from "@/hooks/use-mobile"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as touchCapableModule from "@/hooks/use-touch-capable"
import { DOUBLE_TAP_MS } from "@/hooks/use-zoom-pan"
import type { AttachmentSummary } from "@threa/types"

const WIDTH = 400

// The toggle is deferred past the double-tap window; anything that should NOT
// have fired needs a real-time wait comfortably past it before asserting.
const AFTER_WINDOW = DOUBLE_TAP_MS + 150
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let offsetWidthSpy: PropertyDescriptor | undefined

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(attachmentsApi, "getDownloadUrl").mockResolvedValue("https://example.com/img")
  vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("touch")
  vi.spyOn(touchCapableModule, "useTouchCapable").mockReturnValue(true)
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
  offsetWidthSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => WIDTH })
})

afterEach(() => {
  if (offsetWidthSpy) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthSpy)
})

const img = (id: string, filename: string): AttachmentSummary => ({
  id,
  filename,
  mimeType: "image/png",
  sizeBytes: 1024,
})

function renderGallery() {
  const attachments = [img("img_1", "photo1.png"), img("img_2", "photo2.png"), img("img_3", "photo3.png")]
  const router = createMemoryRouter(
    [
      {
        path: "/s",
        element: (
          <MediaGalleryProvider>
            <AttachmentList attachments={attachments} workspaceId="ws_1" />
          </MediaGalleryProvider>
        ),
      },
    ],
    { initialEntries: ["/s"] }
  )
  render(<RouterProvider router={router} />)
}

/** The touch tap surface: the strip's clipping container, which owns onClick. */
function tapContainer(): HTMLElement {
  const dialog = screen.getByRole("dialog")
  const strip = dialog.querySelector<HTMLElement>('div[style*="will-change"]')
  const container = strip?.parentElement
  if (!container) throw new Error("tap container not found")
  // jsdom rects are all zeros; the tap handler derives its left/right/middle
  // zone from the container rect, so give it a real one.
  container.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: WIDTH,
      bottom: 800,
      width: WIDTH,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  return container
}

/** ZoomableImage's viewport (only the current image slide mounts it). jsdom's
 *  cssstyle drops `touch-action`, so locate it via the main img's alt — the
 *  zoomable viewport is its direct parent (it owns the gesture listeners). */
function zoomContainer(): HTMLElement {
  const img = within(screen.getByRole("dialog")).getByAltText("photo2.png")
  const container = img.parentElement
  if (!container) throw new Error("zoom container not found")
  return container
}

function closeButton(): HTMLElement {
  return within(screen.getByRole("dialog")).getByRole("button", { name: /close/i, hidden: true })
}

const chromeHidden = () => closeButton().closest("[inert]") !== null

describe("MediaGallery touch chrome toggle", () => {
  it("hides and re-shows the chrome on a single middle tap, and resets to visible on reopen", async () => {
    const user = userEvent.setup()
    renderGallery()

    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    expect(chromeHidden()).toBe(false)

    // Single middle tap hides the chrome once the double-tap window passes.
    fireEvent.click(tapContainer(), { clientX: WIDTH / 2 })
    expect(chromeHidden()).toBe(false) // deferred, not immediate
    await waitFor(() => expect(chromeHidden()).toBe(true))

    // Tap again brings it back.
    fireEvent.click(tapContainer(), { clientX: WIDTH / 2 })
    await waitFor(() => expect(chromeHidden()).toBe(false))

    // Hide, close via Escape, reopen: chrome must reset to visible.
    fireEvent.click(tapContainer(), { clientX: WIDTH / 2 })
    await waitFor(() => expect(chromeHidden()).toBe(true))
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    expect(chromeHidden()).toBe(false)
  })

  it("treats two quick taps as a double-tap: no toggle fires", async () => {
    const user = userEvent.setup()
    renderGallery()

    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    fireEvent.click(tapContainer(), { clientX: WIDTH / 2 })
    fireEvent.click(tapContainer(), { clientX: WIDTH / 2 })
    await sleep(AFTER_WINDOW)
    expect(chromeHidden()).toBe(false)
  })

  it("keeps edge taps as navigation, not chrome toggles", async () => {
    const user = userEvent.setup()
    renderGallery()

    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByText("2 / 3")).toBeInTheDocument())

    // Left-zone tap navigates back immediately and never toggles.
    fireEvent.click(tapContainer(), { clientX: WIDTH * 0.1 })
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument())
    await sleep(AFTER_WINDOW)
    expect(chromeHidden()).toBe(false)

    // At the first slide there is no prev — the same left-zone tap now toggles.
    fireEvent.click(tapContainer(), { clientX: WIDTH * 0.1 })
    await waitFor(() => expect(chromeHidden()).toBe(true))
  })

  it("zoom never hides the chrome, taps toggle while zoomed, and zooming out re-shows it", async () => {
    const user = userEvent.setup()
    renderGallery()

    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByText("2 / 3")).toBeInTheDocument())
    // ZoomableImage mounts only once the slide's full-resolution URL resolves.
    await waitFor(() => zoomContainer())

    // Double-click zoom (the desktop analogue of double-tap; same commit path)
    // leaves visible chrome alone.
    fireEvent.dblClick(zoomContainer(), { clientX: 100, clientY: 100 })
    await sleep(AFTER_WINDOW)
    expect(chromeHidden()).toBe(false)

    // While zoomed, an edge tap toggles instead of navigating.
    fireEvent.click(tapContainer(), { clientX: WIDTH * 0.1 })
    await waitFor(() => expect(chromeHidden()).toBe(true))
    expect(screen.getByText("2 / 3")).toBeInTheDocument()

    // Zooming all the way back out re-shows the chrome immediately.
    fireEvent.dblClick(zoomContainer(), { clientX: 100, clientY: 100 })
    await waitFor(() => expect(chromeHidden()).toBe(false))
  })
})
