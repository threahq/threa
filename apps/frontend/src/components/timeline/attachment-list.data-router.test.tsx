import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { MediaGalleryProvider } from "@/contexts"
import { attachmentsApi } from "@/api"
import { AttachmentList } from "./attachment-list"
import type { AttachmentSummary } from "@threahq/types"

const mockGetDownloadUrl = vi.fn()

beforeEach(() => {
  vi.restoreAllMocks()
  mockGetDownloadUrl.mockReset()
  mockGetDownloadUrl.mockResolvedValue("https://example.com/download")
  vi.spyOn(attachmentsApi, "getDownloadUrl").mockImplementation(
    (...args: Parameters<typeof attachmentsApi.getDownloadUrl>) => mockGetDownloadUrl(...args)
  )
})

const workspaceId = "ws_123"

const img = (id: string, filename: string): AttachmentSummary => ({
  id,
  filename,
  mimeType: "image/png",
  sizeBytes: 1024,
})

function renderWithDataRouter() {
  const attachments = [img("img_1", "photo1.png"), img("img_2", "photo2.png"), img("img_3", "photo3.png")]
  const router = createMemoryRouter(
    [
      {
        path: "/s",
        element: (
          <MediaGalleryProvider>
            <AttachmentList attachments={attachments} workspaceId={workspaceId} />
          </MediaGalleryProvider>
        ),
      },
    ],
    { initialEntries: ["/s"] }
  )
  render(<RouterProvider router={router} />)
  return router
}

describe("AttachmentList gallery under a data router (createBrowserRouter machinery)", () => {
  it("opens the clicked image, not the first, on first open", async () => {
    const user = userEvent.setup()
    renderWithDataRouter()

    const third = await screen.findByRole("button", { name: /photo3\.png/i })
    await user.click(third)

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    expect(screen.getByText("3 / 3")).toBeInTheDocument()
  })

  it("opens the correct image after closing a previous one via the back button", async () => {
    const user = userEvent.setup()
    const router = renderWithDataRouter()

    // Open the 3rd image.
    await user.click(await screen.findByRole("button", { name: /photo3\.png/i }))
    await waitFor(() => expect(screen.getByText("3 / 3")).toBeInTheDocument())

    // Close it — closeMedia pops history (navigate(-1)).
    const closeButtons = screen.getAllByRole("button", { name: /close/i })
    await user.click(closeButtons[0])
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(router.state.location.search).toBe("")

    // Re-open a different image — must land on it, not the first.
    await user.click(await screen.findByRole("button", { name: /photo2\.png/i }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    expect(screen.getByText("2 / 3")).toBeInTheDocument()
  })
})
