import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { PendingAttachments } from "./pending-attachments"
import type { PendingAttachment } from "@/hooks/use-attachments"

function imageAttachment(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    id: "attach_img",
    filename: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    status: "uploaded",
    previewUrl: "blob:preview-1",
    ...overrides,
  }
}

describe("PendingAttachments", () => {
  it("renders an image upload as a preview thumbnail", () => {
    render(<PendingAttachments attachments={[imageAttachment()]} onRemove={vi.fn()} workspaceId="ws_1" />)

    const preview = screen.getByRole("button", { name: "Preview screenshot.png" })
    expect(preview).toBeInTheDocument()
    // Both the tile and the hover-card render the object URL.
    expect(screen.getAllByAltText("screenshot.png")[0]).toHaveAttribute("src", "blob:preview-1")
  })

  it("falls back to a labeled pill for non-image files", () => {
    const file: PendingAttachment = {
      id: "attach_doc",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 1024,
      status: "uploaded",
    }
    render(<PendingAttachments attachments={[file]} onRemove={vi.fn()} workspaceId="ws_1" />)

    expect(screen.getByText("notes.txt")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Preview / })).not.toBeInTheDocument()
  })

  it("opens the lightbox when the thumbnail is clicked", () => {
    render(<PendingAttachments attachments={[imageAttachment()]} onRemove={vi.fn()} workspaceId="ws_1" />)

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Preview screenshot.png" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("removes an image via its remove control without opening the lightbox", () => {
    const onRemove = vi.fn()
    render(<PendingAttachments attachments={[imageAttachment()]} onRemove={onRemove} workspaceId="ws_1" />)

    fireEvent.click(screen.getByRole("button", { name: "Remove screenshot.png" }))
    expect(onRemove).toHaveBeenCalledWith("attach_img")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("previews an image that is still uploading (no remove control yet)", () => {
    render(
      <PendingAttachments
        attachments={[imageAttachment({ status: "uploading" })]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
      />
    )

    expect(screen.getByRole("button", { name: "Preview screenshot.png" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove screenshot.png" })).not.toBeInTheDocument()
  })
})
