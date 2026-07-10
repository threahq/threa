import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { PendingAttachments } from "./pending-attachments"
import type { PendingAttachment } from "@/hooks/use-attachments"
import * as uploadManager from "@/lib/uploads/upload-manager"

function attachment(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
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
  it("renders an image upload as a chip with a preview thumbnail", () => {
    const { container } = render(
      <PendingAttachments attachments={[attachment()]} onRemove={vi.fn()} workspaceId="ws_1" />
    )

    // Filename stays visible as chip text; the leading slot shows the thumbnail.
    expect(screen.getByText("screenshot.png")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview screenshot.png" })).toBeInTheDocument()
    expect(container.querySelector('img[src="blob:preview-1"]')).toBeTruthy()
  })

  it("makes a pdf upload previewable from local bytes", () => {
    render(
      <PendingAttachments
        attachments={[
          attachment({ id: "attach_pdf", filename: "report.pdf", mimeType: "application/pdf", previewUrl: "blob:pdf" }),
        ]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
      />
    )

    expect(screen.getByText("report.pdf")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview report.pdf" })).toBeInTheDocument()
  })

  it("makes a text upload previewable from local bytes", () => {
    render(
      <PendingAttachments
        attachments={[
          attachment({ id: "attach_txt", filename: "notes.txt", mimeType: "text/plain", previewUrl: "blob:txt" }),
        ]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
      />
    )

    expect(screen.getByRole("button", { name: "Preview notes.txt" })).toBeInTheDocument()
  })

  it("opens the lightbox when a video chip is activated", () => {
    render(
      <PendingAttachments
        attachments={[
          attachment({ id: "attach_vid", filename: "clip.mp4", mimeType: "video/mp4", previewUrl: "blob:vid" }),
        ]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
      />
    )

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Preview clip.mp4" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("offers an in-place retry on a retryable failed chip", () => {
    const retrySpy = vi.spyOn(uploadManager, "retryUpload").mockResolvedValue(undefined)
    render(
      <PendingAttachments
        attachments={[attachment({ status: "error", error: "Network error during upload", canRetry: true })]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
      />
    )

    expect(screen.getByText("Retry")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry upload of screenshot.png" }))
    expect(retrySpy).toHaveBeenCalledWith("attach_img")
    retrySpy.mockRestore()
  })

  it("keeps remove-only recovery for a reservation failure (nothing to retry against)", () => {
    render(
      <PendingAttachments
        attachments={[attachment({ status: "error", error: "Internal server error", canRetry: false })]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
      />
    )

    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Retry upload/ })).not.toBeInTheDocument()
  })

  it("keeps a plain, non-previewable chip for an unsupported file type", () => {
    render(
      <PendingAttachments
        attachments={[
          attachment({ id: "attach_zip", filename: "archive.zip", mimeType: "application/zip", previewUrl: undefined }),
        ]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
      />
    )

    expect(screen.getByText("archive.zip")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Preview / })).not.toBeInTheDocument()
  })

  it("shows a non-image doc without local bytes as a plain chip (reloaded draft)", () => {
    // No previewUrl and no decrypt ref: the server bytes sit behind a presign the
    // static path doesn't reach, so a reloaded non-image draft attachment falls
    // back to a type icon rather than a broken preview.
    const file: PendingAttachment = {
      id: "attach_doc",
      filename: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      status: "uploaded",
    }
    render(<PendingAttachments attachments={[file]} onRemove={vi.fn()} workspaceId="ws_1" />)

    expect(screen.getByText("spec.pdf")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Preview / })).not.toBeInTheDocument()
  })

  it("opens the lightbox when the image chip is activated", () => {
    render(<PendingAttachments attachments={[attachment()]} onRemove={vi.fn()} workspaceId="ws_1" />)

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Preview screenshot.png" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("removes an image via its remove control without opening the lightbox", () => {
    const onRemove = vi.fn()
    render(<PendingAttachments attachments={[attachment()]} onRemove={onRemove} workspaceId="ws_1" />)

    fireEvent.click(screen.getByRole("button", { name: "Remove screenshot.png" }))
    expect(onRemove).toHaveBeenCalledWith("attach_img")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("shows a Cancel control while an image is still uploading, so a stuck upload can be abandoned", () => {
    render(
      <PendingAttachments
        attachments={[attachment({ status: "uploading" })]}
        onRemove={vi.fn()}
        onCancelUpload={vi.fn()}
        workspaceId="ws_1"
      />
    )

    expect(screen.getByRole("button", { name: "Preview screenshot.png" })).toBeInTheDocument()
    // The × stays available during upload; it cancels the in-flight transfer
    // instead of removing an already-settled chip.
    expect(screen.getByRole("button", { name: "Cancel upload of screenshot.png" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove screenshot.png" })).not.toBeInTheDocument()
  })

  it("clicking the × during upload cancels the transfer, not the remove path", () => {
    const onRemove = vi.fn()
    const onCancelUpload = vi.fn()
    render(
      <PendingAttachments
        attachments={[attachment({ status: "uploading" })]}
        onRemove={onRemove}
        onCancelUpload={onCancelUpload}
        workspaceId="ws_1"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Cancel upload of screenshot.png" }))
    expect(onCancelUpload).toHaveBeenCalledWith("attach_img")
    expect(onRemove).not.toHaveBeenCalled()
  })

  it("shows a gradually-filling progress bar while uploading (no counting number)", () => {
    render(
      <PendingAttachments
        attachments={[attachment({ status: "uploading", progress: 0.42 })]}
        onRemove={vi.fn()}
        onCancelUpload={vi.fn()}
        workspaceId="ws_1"
      />
    )

    const bar = screen.getByRole("progressbar", { name: "Uploading screenshot.png" })
    expect(bar).toHaveAttribute("aria-valuenow", "42")
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument()
  })
})
