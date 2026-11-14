import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, render, screen, waitFor, within, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { MediaGalleryProvider } from "@/contexts"
import { attachmentsApi } from "@/api"
import { AttachmentList } from "@/components/timeline/attachment-list"
import * as useMobileModule from "@/hooks/use-mobile"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as touchCapableModule from "@/hooks/use-touch-capable"
import type { AttachmentSummary } from "@threahq/types"

const IDLE_MS = 2500

beforeEach(() => {
  vi.restoreAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.spyOn(attachmentsApi, "getDownloadUrl").mockResolvedValue("https://example.com/img")
  vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("mouse")
  vi.spyOn(touchCapableModule, "useTouchCapable").mockReturnValue(false)
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

const img = (id: string, filename: string): AttachmentSummary => ({
  id,
  filename,
  mimeType: "image/png",
  sizeBytes: 1024,
})

function renderGallery() {
  const attachments = [img("img_1", "photo1.png"), img("img_2", "photo2.png")]
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

const dialog = () => screen.getByRole("dialog")
const closeButton = () => within(dialog()).getByRole("button", { name: /close/i, hidden: true })
const chromeHidden = () => closeButton().closest("[inert]") !== null
// The thumbnail panel repeats each alt; the viewed slide renders first.
const media = () => within(dialog()).getAllByAltText("photo1.png")[0]
const idle = () => act(() => vi.advanceTimersByTime(IDLE_MS))

async function openGallery() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  renderGallery()
  await user.click(await screen.findByRole("button", { name: /photo1\.png/i }))
  await waitFor(() => expect(dialog()).toBeInTheDocument())
  return user
}

describe("MediaGallery desktop chrome", () => {
  it("fades after the mouse rests and returns on the next move or key press", async () => {
    await openGallery()
    expect(chromeHidden()).toBe(false)

    idle()
    expect(chromeHidden()).toBe(true)
    expect(dialog()).toBeInTheDocument()

    fireEvent.pointerMove(media(), { pointerType: "mouse" })
    expect(chromeHidden()).toBe(false)

    idle()
    expect(chromeHidden()).toBe(true)
    fireEvent.keyDown(dialog(), { key: "ArrowRight" })
    expect(chromeHidden()).toBe(false)
    expect(within(dialog()).getByText("2 / 2")).toBeInTheDocument()

    idle()
    expect(chromeHidden()).toBe(true)
    expect(dialog()).toBeInTheDocument()
  })

  it("stays up while the pointer rests on a control", async () => {
    await openGallery()

    fireEvent.pointerMove(closeButton(), { pointerType: "mouse" })
    idle()
    expect(chromeHidden()).toBe(false)

    fireEvent.pointerMove(media(), { pointerType: "mouse" })
    idle()
    expect(chromeHidden()).toBe(true)
  })

  it("stays up while a control has keyboard focus", async () => {
    const user = await openGallery()
    await user.tab()
    expect(closeButton().closest("[data-gallery-chrome]")).toContainElement(document.activeElement as HTMLElement)
    idle()
    expect(chromeHidden()).toBe(false)
  })
})
