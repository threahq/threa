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
import { DOUBLE_TAP_MS } from "@/hooks/use-zoom-pan"
import type { AttachmentSummary } from "@threahq/types"
import { loadMediaPreferences } from "./preferences"

const WIDTH = 300
const AFTER_WINDOW = DOUBLE_TAP_MS + 150
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let offsetWidthDescriptor: PropertyDescriptor | undefined

function useInput(mode: "mouse" | "touch") {
  vi.spyOn(inputModeModule, "useInputMode").mockReturnValue(mode)
  vi.spyOn(touchCapableModule, "useTouchCapable").mockReturnValue(mode === "touch")
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(mode === "touch")
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem("threa:media-player:preferences")
  vi.spyOn(attachmentsApi, "getDownloadUrl").mockResolvedValue("https://example.com/media")
  offsetWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => WIDTH })
})

afterEach(() => {
  if (offsetWidthDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDescriptor)
})

const attachments: AttachmentSummary[] = [
  { id: "vid_1", filename: "clip.mp4", mimeType: "video/mp4", sizeBytes: 4096, processingStatus: "completed" },
  { id: "img_1", filename: "photo.png", mimeType: "image/png", sizeBytes: 1024 },
]

const dialog = () => screen.getByRole("dialog")
const position = () => within(dialog()).getByText(/^\d+ \/ \d+$/).textContent
const closeButton = () => within(dialog()).getByRole("button", { name: /close/i, hidden: true })
const chromeHidden = () => closeButton().closest("[inert]") !== null

function stubMedia(video: HTMLVideoElement) {
  let time = 0
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => time,
    set: (t: number) => {
      time = t
    },
  })
  Object.defineProperty(video, "duration", { configurable: true, get: () => 120 })
  Object.defineProperty(video, "buffered", {
    configurable: true,
    get: () => ({ length: 1, start: () => 0, end: () => 30 }),
  })
  video.play = vi.fn(() => Promise.resolve())
  video.pause = vi.fn()
  fireEvent(video, new Event("durationchange"))
}

/** The player root is the gesture surface; jsdom rects are zero, so give it one. */
function surface(): HTMLElement {
  const root = dialog().querySelector<HTMLElement>("[data-media-player]")
  if (!root) throw new Error("player not mounted")
  root.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: WIDTH,
      bottom: 600,
      width: WIDTH,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  return root
}

async function openVideo() {
  const user = userEvent.setup()
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
  await user.click(await screen.findByRole("button", { name: /clip\.mp4/i }))
  const video = await waitFor(() => {
    const el = dialog().querySelector("video")
    if (!el) throw new Error("video not mounted")
    return el
  })
  stubMedia(video)
  return { user, video }
}

describe("VideoPlayer in the gallery (mouse)", () => {
  beforeEach(() => useInput("mouse"))

  it("renders Threa controls instead of native ones, with the filename once", async () => {
    const { video } = await openVideo()

    expect(video.hasAttribute("controls")).toBe(false)
    expect(within(dialog()).getByRole("slider", { name: "Seek" })).toHaveAttribute("aria-valuetext", "0:00 of 2:00")
    expect(within(dialog()).getByRole("button", { name: "Playback speed 1×" })).toBeInTheDocument()
    const visibleNames = within(dialog())
      .getAllByText("clip.mp4")
      .filter((el) => !el.classList.contains("sr-only"))
    expect(visibleNames).toHaveLength(1)
  })

  it("seeks on ←/→ instead of changing item, while ↑/↓ still navigate", async () => {
    const { video } = await openVideo()
    expect(position()).toBe("2 / 2")

    fireEvent.keyDown(dialog(), { key: "ArrowRight" })
    fireEvent.keyDown(dialog(), { key: "ArrowRight" })
    expect({ position: position(), time: video.currentTime }).toEqual({ position: "2 / 2", time: 10 })
    fireEvent.keyDown(dialog(), { key: "ArrowLeft" })
    expect({ position: position(), time: video.currentTime }).toEqual({ position: "2 / 2", time: 5 })

    fireEvent.keyDown(dialog(), { key: "ArrowUp" })
    await waitFor(() => expect(position()).toBe("1 / 2"))
    fireEvent.keyDown(dialog(), { key: "ArrowDown" })
    await waitFor(() => expect(position()).toBe("2 / 2"))
  })

  it("toggles playback with Space when the player has focus", async () => {
    const { video } = await openVideo()
    expect(document.activeElement).toBe(surface())
    fireEvent.keyDown(document.activeElement!, { key: " " })
    expect(video.play).toHaveBeenCalledTimes(1)
  })

  it("keeps Space and ↑/↓ working while the seek thumb has focus", async () => {
    const { video } = await openVideo()
    const thumb = within(dialog()).getByRole("slider", { name: "Seek" })
    thumb.focus()

    fireEvent.keyDown(thumb, { key: " " })
    expect(video.play).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(thumb, { key: "ArrowUp" })
    await waitFor(() => expect(position()).toBe("1 / 2"))
  })

  it("says so when the video can't be played", async () => {
    const { video } = await openVideo()
    fireEvent(video, new Event("error"))

    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Can't play this video")
  })

  it("applies the chosen speed and keeps it for the next video", async () => {
    const { user, video } = await openVideo()

    await user.click(within(dialog()).getByRole("button", { name: "Playback speed 1×" }))
    await user.click(await screen.findByRole("menuitemradio", { name: "1.5×" }))

    expect({
      rate: video.playbackRate,
      stored: loadMediaPreferences().playbackRate,
      played: vi.mocked(video.play).mock.calls.length,
    }).toEqual({ rate: 1.5, stored: 1.5, played: 0 })
    expect(within(dialog()).getByRole("button", { name: "Playback speed 1.5×" })).toBeInTheDocument()
  })

  it("double-click on the right third seeks +10s, and a chained click adds 10s more", async () => {
    const { video } = await openVideo()
    const root = surface()

    fireEvent.click(root, { clientX: WIDTH - 20 })
    expect(video.play).toHaveBeenCalledTimes(1)
    fireEvent.click(root, { clientX: WIDTH - 20 })
    expect(video.currentTime).toBe(10)
    fireEvent.click(root, { clientX: WIDTH - 20 })
    expect(video.currentTime).toBe(20)
    expect(within(root).getByText("20s")).toBeInTheDocument()
  })

  it("a single center click toggles playback immediately", async () => {
    const { video } = await openVideo()
    fireEvent.click(surface(), { clientX: WIDTH / 2 })
    expect({ plays: vi.mocked(video.play).mock.calls.length, time: video.currentTime }).toEqual({ plays: 1, time: 0 })
  })
})

describe("VideoPlayer in the gallery (touch)", () => {
  beforeEach(() => useInput("touch"))

  it("a single tap toggles the chrome after the double-tap window", async () => {
    await openVideo()
    expect(chromeHidden()).toBe(false)

    fireEvent.click(surface(), { clientX: WIDTH / 2 })
    expect(chromeHidden()).toBe(false)
    await waitFor(() => expect(chromeHidden()).toBe(true))
  })

  it("a double tap on a side seeks and never toggles the chrome, and edge taps don't navigate", async () => {
    const { video } = await openVideo()
    const root = surface()
    video.currentTime = 60

    fireEvent.click(root, { clientX: 20 })
    fireEvent.click(root, { clientX: 20 })
    expect(video.currentTime).toBe(50)
    fireEvent.click(root, { clientX: 20 })
    expect(video.currentTime).toBe(40)
    expect(within(root).getByText("20s")).toBeInTheDocument()

    await act(() => sleep(AFTER_WINDOW))
    expect({ hidden: chromeHidden(), position: position() }).toEqual({ hidden: false, position: "2 / 2" })
  })
})
