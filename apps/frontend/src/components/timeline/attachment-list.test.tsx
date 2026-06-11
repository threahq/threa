import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { MediaGalleryProvider } from "@/contexts"
import { attachmentsApi } from "@/api"
import { AttachmentList } from "./attachment-list"
import type { AttachmentSummary } from "@threa/types"

const mockGetDownloadUrl = vi.fn()

beforeEach(() => {
  vi.restoreAllMocks()
  mockGetDownloadUrl.mockReset()
  mockGetDownloadUrl.mockResolvedValue("https://example.com/download")
  vi.spyOn(attachmentsApi, "getDownloadUrl").mockImplementation(
    (...args: Parameters<typeof attachmentsApi.getDownloadUrl>) => mockGetDownloadUrl(...args)
  )
})

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <MediaGalleryProvider>{children}</MediaGalleryProvider>
    </MemoryRouter>
  )
}

const renderOpts = { wrapper: Wrapper }

describe("AttachmentList", () => {
  const workspaceId = "ws_123"

  const createAttachment = (overrides: Partial<AttachmentSummary> = {}): AttachmentSummary => ({
    id: "attach_abc123",
    filename: "document.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    ...overrides,
  })

  describe("rendering", () => {
    it("should render nothing when attachments is empty", () => {
      const { container } = render(<AttachmentList attachments={[]} workspaceId={workspaceId} />, renderOpts)
      expect(container.firstChild).toBeNull()
    })

    it("should render nothing when attachments is undefined", () => {
      const { container } = render(
        <AttachmentList attachments={undefined as unknown as AttachmentSummary[]} workspaceId={workspaceId} />,
        renderOpts
      )
      expect(container.firstChild).toBeNull()
    })

    it("should render file attachment with filename", () => {
      const attachment = createAttachment({ filename: "report.pdf" })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      expect(screen.getByText("report.pdf")).toBeInTheDocument()
    })

    it("should render multiple file attachments", () => {
      const attachments = [
        createAttachment({ id: "1", filename: "file1.pdf" }),
        createAttachment({ id: "2", filename: "file2.txt", mimeType: "text/plain" }),
      ]
      render(<AttachmentList attachments={attachments} workspaceId={workspaceId} />, renderOpts)

      expect(screen.getByText("file1.pdf")).toBeInTheDocument()
      expect(screen.getByText("file2.txt")).toBeInTheDocument()
    })

    it("should render image attachments as thumbnails", () => {
      const attachment = createAttachment({
        id: "img_1",
        filename: "photo.png",
        mimeType: "image/png",
      })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      // Inline view renders the stable thumbnail-variant content URL
      // synchronously — no presign request before the <img> has a src.
      const image = screen.getByAltText("photo.png")
      expect(image).toHaveAttribute("src", `/api/workspaces/${workspaceId}/attachments/img_1/content?variant=thumbnail`)
      expect(mockGetDownloadUrl).not.toHaveBeenCalled()
    })

    it("should defer image hydration when requested", () => {
      const attachment = createAttachment({
        id: "img_1",
        filename: "photo.png",
        mimeType: "image/png",
      })
      const { rerender } = render(
        <AttachmentList attachments={[attachment]} workspaceId={workspaceId} deferHydration={true} />,
        renderOpts
      )

      expect(screen.queryByAltText("photo.png")).not.toBeInTheDocument()

      rerender(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} deferHydration={false} />)

      expect(screen.getByAltText("photo.png")).toBeInTheDocument()
    })

    it("should separate images and files into different groups", async () => {
      const attachments = [
        createAttachment({ id: "1", filename: "photo.jpg", mimeType: "image/jpeg" }),
        createAttachment({ id: "2", filename: "doc.pdf", mimeType: "application/pdf" }),
      ]
      render(<AttachmentList attachments={attachments} workspaceId={workspaceId} />, renderOpts)

      // Both should be rendered
      await waitFor(() => {
        expect(screen.getByAltText("photo.jpg")).toBeInTheDocument()
      })
      expect(screen.getByText("doc.pdf")).toBeInTheDocument()
    })

    it("should not render a thumbnail while videos are processing", () => {
      const attachment = createAttachment({
        id: "video_1",
        filename: "clip.mov",
        mimeType: "video/quicktime",
        processingStatus: "processing",
      })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      expect(screen.getByText("Processing...")).toBeInTheDocument()
      expect(screen.queryByAltText("clip.mov")).not.toBeInTheDocument()
    })

    it("should render skipped videos without a thumbnail src", () => {
      const attachment = createAttachment({
        id: "video_1",
        filename: "clip.mov",
        mimeType: "video/quicktime",
        processingStatus: "skipped",
      })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      expect(screen.getByRole("button", { name: "clip.mov" })).toBeInTheDocument()
      // A skipped transcode has no thumbnail object — the variant URL would
      // fall through to raw video bytes, which an <img> can't render.
      expect(screen.getByAltText("clip.mov")).not.toHaveAttribute("src")
    })

    it("should render the thumbnail content URL for completed videos", () => {
      const attachment = createAttachment({
        id: "video_1",
        filename: "clip.mov",
        mimeType: "video/quicktime",
        processingStatus: "completed",
      })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      expect(screen.getByAltText("clip.mov")).toHaveAttribute(
        "src",
        `/api/workspaces/${workspaceId}/attachments/video_1/content?variant=thumbnail`
      )
    })
  })

  describe("file size formatting", () => {
    it("should display bytes for small files", () => {
      const attachment = createAttachment({ sizeBytes: 500 })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      expect(screen.getByText("500 B")).toBeInTheDocument()
    })

    it("should display KB for files over 1KB", () => {
      const attachment = createAttachment({ sizeBytes: 2048 })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      expect(screen.getByText("2.0 KB")).toBeInTheDocument()
    })

    it("should display MB for files over 1MB", () => {
      const attachment = createAttachment({ sizeBytes: 5 * 1024 * 1024 })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      expect(screen.getByText("5.0 MB")).toBeInTheDocument()
    })

    it("should display fractional KB", () => {
      const attachment = createAttachment({ sizeBytes: 1536 }) // 1.5 KB
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      expect(screen.getByText("1.5 KB")).toBeInTheDocument()
    })
  })

  describe("file download", () => {
    it("should trigger download when file attachment clicked", async () => {
      const attachment = createAttachment({ mimeType: "text/plain", filename: "notes.txt" })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      // Set up download mocks after render to avoid interfering with React
      const originalCreateElement = document.createElement.bind(document)
      const clickSpy = vi.fn()
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        const element = originalCreateElement(tagName)
        if (tagName === "a") {
          element.click = clickSpy
        }
        return element
      })

      const button = screen.getByRole("button")
      fireEvent.click(button)

      await waitFor(() => {
        expect(clickSpy).toHaveBeenCalled()
      })
    })

    it("should open PDF in the media gallery instead of downloading it", async () => {
      const user = userEvent.setup()
      const attachment = createAttachment({ mimeType: "application/pdf", filename: "report.pdf" })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      const button = screen.getByRole("button", { name: /report\.pdf/i })
      await user.click(button)

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument()
      })
    })
  })

  describe("image lightbox", () => {
    it("should open lightbox when image is clicked", async () => {
      const user = userEvent.setup()
      const attachment = createAttachment({
        id: "img_1",
        filename: "photo.png",
        mimeType: "image/png",
      })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      // Wait for image to load
      const imageButton = await screen.findByRole("button", { name: /photo\.png/i })

      await user.click(imageButton)

      // Lightbox should open with dialog
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument()
      })
    })

    it("should open the lightbox on the clicked image, not the first", async () => {
      const user = userEvent.setup()
      const attachments = [
        createAttachment({ id: "img_1", filename: "photo1.png", mimeType: "image/png" }),
        createAttachment({ id: "img_2", filename: "photo2.png", mimeType: "image/png" }),
        createAttachment({ id: "img_3", filename: "photo3.png", mimeType: "image/png" }),
      ]
      render(<AttachmentList attachments={attachments} workspaceId={workspaceId} />, renderOpts)

      const thirdImage = await screen.findByRole("button", { name: /photo3\.png/i })
      await user.click(thirdImage)

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument()
      })
      // Counter is "<index+1> / <total>" — clicking the third image must land on 3.
      expect(screen.getByText("3 / 3")).toBeInTheDocument()
    })

    it("should close lightbox when close button is clicked", async () => {
      const user = userEvent.setup()
      const attachment = createAttachment({
        id: "img_1",
        filename: "photo.png",
        mimeType: "image/png",
      })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      // Wait for image to load
      const imageButton = await screen.findByRole("button", { name: /photo\.png/i })

      await user.click(imageButton)

      // Wait for dialog to open
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument()
      })

      // Click close button (DialogContent has its own, use first one)
      const closeButtons = screen.getAllByRole("button", { name: /close/i })
      await user.click(closeButtons[0])

      // Dialog should close
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      })
    })
  })

  describe("error handling", () => {
    it("should show error state when image fails to load", async () => {
      const attachment = createAttachment({
        id: "img_1",
        filename: "broken.png",
        mimeType: "image/png",
      })
      render(<AttachmentList attachments={[attachment]} workspaceId={workspaceId} />, renderOpts)

      fireEvent.error(screen.getByAltText("broken.png"))

      expect(await screen.findByText("Failed to load image")).toBeInTheDocument()
    })
  })
})
