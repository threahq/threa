import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { PendingAttachments } from "./pending-attachments"
import type { PendingAttachment } from "@/hooks/use-attachments"
import * as uploadManager from "@/lib/uploads/upload-manager"
import * as useMobileModule from "@/hooks/use-mobile"

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

describe("mobile rollup and drawer", () => {
  beforeEach(() => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const files = [
    attachment({ id: "attach_ok", filename: "ok.png", previewUrl: "blob:ok" }),
    attachment({ id: "attach_up", filename: "up.png", status: "uploading", progress: 0.4, previewUrl: "blob:up" }),
    attachment({
      id: "attach_net",
      filename: "net.txt",
      mimeType: "text/plain",
      status: "error",
      error: "Network error during upload",
      canRetry: true,
      previewUrl: undefined,
    }),
    attachment({
      id: "attach_dead",
      filename: "dead.txt",
      mimeType: "text/plain",
      status: "error",
      error: "size mismatch",
      canRetry: false,
      previewUrl: undefined,
    }),
  ]

  it("summarizes the tray in one line and bulk-retries only the retryable failures", () => {
    const retrySpy = vi.spyOn(uploadManager, "retryUpload").mockResolvedValue(undefined)
    render(<PendingAttachments attachments={files} onRemove={vi.fn()} workspaceId="ws_1" />)

    const summary = screen.getByRole("button", { name: "Show all attachments" })
    expect(summary).toHaveTextContent(/4 files/)
    expect(summary).toHaveTextContent(/1 uploading/)
    expect(summary).toHaveTextContent(/2 failed/)

    // The button carries the retryable count, not "all" — the failed tally
    // includes terminal failures a retry can never fix.
    fireEvent.click(screen.getByRole("button", { name: "Retry 1" }))
    expect(retrySpy.mock.calls.map((call) => call[0])).toEqual(["attach_net"])
  })

  it("shows only the rollup line while the composer rests, with the drawer still reachable", () => {
    render(<PendingAttachments attachments={files} onRemove={vi.fn()} workspaceId="ws_1" resting />)

    expect(screen.queryByText("ok.png")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Hide attachment chips" })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Show all attachments" }))
    expect(within(screen.getByRole("dialog")).getByText("ok.png")).toBeInTheDocument()
  })

  it("resting folds context-ref pills too, matching the link-preview rule", () => {
    render(
      <PendingAttachments
        attachments={[]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
        resting
        beforePills={<span>context-ref-pill</span>}
      />
    )

    expect(screen.queryByText("context-ref-pill")).not.toBeInTheDocument()
  })

  it("folds the chips away behind the rollup line and restores them", () => {
    render(<PendingAttachments attachments={files} onRemove={vi.fn()} workspaceId="ws_1" />)
    expect(screen.getByText("ok.png")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Hide attachment chips" }))
    expect(screen.queryByText("ok.png")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show all attachments" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Show attachment chips" }))
    expect(screen.getByText("ok.png")).toBeInTheDocument()
  })

  it("opens the drawer with full filenames, live status, and per-row recovery", () => {
    const retrySpy = vi.spyOn(uploadManager, "retryUpload").mockResolvedValue(undefined)
    const onRemove = vi.fn()
    render(<PendingAttachments attachments={files} onRemove={onRemove} workspaceId="ws_1" />)

    fireEvent.click(screen.getByRole("button", { name: "Show all attachments" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("Uploading — 40%")).toBeInTheDocument()
    expect(within(dialog).getByText("Network error during upload")).toBeInTheDocument()
    expect(within(dialog).getByText("size mismatch")).toBeInTheDocument()

    // A terminal failure gets remove-only recovery; the network-class one retries.
    expect(within(dialog).queryByRole("button", { name: "Retry upload of dead.txt" })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry upload of net.txt" }))
    expect(retrySpy).toHaveBeenCalledWith("attach_net")

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove failed" }))
    expect(onRemove.mock.calls.map((call) => call[0])).toEqual(["attach_net", "attach_dead"])
  })

  it("cancels an in-flight upload from its drawer row instead of removing it", () => {
    const onRemove = vi.fn()
    const onCancelUpload = vi.fn()
    render(
      <PendingAttachments attachments={files} onRemove={onRemove} onCancelUpload={onCancelUpload} workspaceId="ws_1" />
    )

    fireEvent.click(screen.getByRole("button", { name: "Show all attachments" }))
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel upload of up.png" }))
    expect(onCancelUpload).toHaveBeenCalledWith("attach_up")
    expect(onRemove).not.toHaveBeenCalled()
  })
})
