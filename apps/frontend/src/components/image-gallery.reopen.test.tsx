import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { MediaGalleryProvider } from "@/contexts"
import { attachmentsApi } from "@/api"
import { AttachmentList } from "@/components/timeline/attachment-list"
import * as useMobileModule from "@/hooks/use-mobile"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as touchCapableModule from "@/hooks/use-touch-capable"
import type { AttachmentSummary } from "@threahq/types"

const WIDTH = 400
const mockGetDownloadUrl = vi.fn()
let offsetWidthSpy: PropertyDescriptor | undefined

beforeEach(() => {
  vi.restoreAllMocks()
  mockGetDownloadUrl.mockReset()
  mockGetDownloadUrl.mockResolvedValue("https://example.com/img")
  vi.spyOn(attachmentsApi, "getDownloadUrl").mockImplementation(
    (...args: Parameters<typeof attachmentsApi.getDownloadUrl>) => mockGetDownloadUrl(...args)
  )
  // The gallery's swipe strip carousel renders for an active touch input and
  // animates whenever touch is available; it still needs a real measured width
  // to position.
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

function stripTransform(): string {
  const dialog = screen.getByRole("dialog")
  const strip = dialog.querySelector<HTMLElement>('div[style*="will-change"]')
  if (!strip) throw new Error("mobile strip not found")
  return strip.style.transform
}

describe("MediaGallery mobile strip positioning across reopen", () => {
  it("positions the strip on the clicked image on first open", async () => {
    const user = userEvent.setup()
    renderGallery()

    await user.click(await screen.findByRole("button", { name: /photo3\.png/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // Image 3 is index 2 -> strip shifted by -2 * width.
    await waitFor(() => expect(stripTransform()).toBe(`translateX(${-2 * WIDTH}px)`))
  })

  it("positions the strip on the newly clicked image after a close+reopen", async () => {
    const user = userEvent.setup()
    renderGallery()

    // Open image 3, then close it (closeMedia -> navigate(-1)).
    await user.click(await screen.findByRole("button", { name: /photo3\.png/i }))
    await waitFor(() => expect(stripTransform()).toBe(`translateX(${-2 * WIDTH}px)`))
    await user.click(screen.getAllByRole("button", { name: /close/i })[0])
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    // Reopen a different image. containerWidth is already known (component
    // never unmounts), so this is the path that previously left the strip
    // stuck on the first/previous slide.
    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // Image 2 is index 1 -> strip must shift to -1 * width, not stay at -2*width.
    await waitFor(() => expect(stripTransform()).toBe(`translateX(${-1 * WIDTH}px)`))
    expect(screen.getByText("2 / 3")).toBeInTheDocument()
  })
})
