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
import type { AttachmentSummary } from "@threa/types"

const WIDTH = 400
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

function closeButton(): HTMLElement {
  return within(screen.getByRole("dialog")).getByRole("button", { name: /close/i, hidden: true })
}

describe("MediaGallery touch chrome toggle", () => {
  it("hides and re-shows the action bar on a middle tap, and resets to visible on reopen", async () => {
    const user = userEvent.setup()
    renderGallery()

    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    expect(closeButton().closest("[inert]")).toBeNull()

    // Middle tap hides the chrome (action bar becomes inert, filename bar hidden).
    fireEvent.click(tapContainer(), { clientX: WIDTH / 2 })
    expect(closeButton().closest("[inert]")).not.toBeNull()

    // Middle tap again brings it back.
    fireEvent.click(tapContainer(), { clientX: WIDTH / 2 })
    expect(closeButton().closest("[inert]")).toBeNull()

    // Hide, close via Escape, reopen: chrome must reset to visible.
    fireEvent.click(tapContainer(), { clientX: WIDTH / 2 })
    expect(closeButton().closest("[inert]")).not.toBeNull()
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    expect(closeButton().closest("[inert]")).toBeNull()
  })

  it("keeps edge taps as navigation, not chrome toggles", async () => {
    const user = userEvent.setup()
    renderGallery()

    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByText("2 / 3")).toBeInTheDocument())

    // Left-zone tap navigates back and leaves the chrome alone.
    fireEvent.click(tapContainer(), { clientX: WIDTH * 0.1 })
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument())
    expect(closeButton().closest("[inert]")).toBeNull()

    // At the first slide there is no prev — the same left-zone tap now toggles.
    fireEvent.click(tapContainer(), { clientX: WIDTH * 0.1 })
    expect(closeButton().closest("[inert]")).not.toBeNull()
  })
})
