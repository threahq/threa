import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { CachedDraft } from "@/hooks"
import { StashedDraftsPicker } from "./stashed-drafts-picker"

function makeDraft(id: string, text: string): CachedDraft {
  return {
    id,
    workspaceId: "ws_1",
    scope: "stream:stream_1",
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    attachments: [],
    clientUpdatedAt: Date.now(),
  }
}

function renderPicker(onDelete: (id: string) => void) {
  return render(
    <TooltipProvider>
      <StashedDraftsPicker
        drafts={[makeDraft("draft_1", "my saved draft")]}
        canStashCurrent={false}
        onStashCurrent={() => {}}
        onRestore={() => {}}
        onDelete={onDelete}
      />
    </TooltipProvider>
  )
}

describe("StashedDraftsPicker delete confirmation", () => {
  it("guards the delete behind a confirm dialog, firing onDelete only after confirming", async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    renderPicker(onDelete)

    await user.click(screen.getByRole("button", { name: /drafts/i }))
    await user.click(await screen.findByRole("button", { name: /delete saved draft/i }))

    // The trash icon does NOT delete immediately — same guard as the Drafts explorer.
    expect(onDelete).not.toHaveBeenCalled()
    expect(await screen.findByText("Delete this draft?")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Delete" }))
    expect(onDelete).toHaveBeenCalledWith("draft_1")
  })

  it("does not delete when the confirm is cancelled", async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    renderPicker(onDelete)

    await user.click(screen.getByRole("button", { name: /drafts/i }))
    await user.click(await screen.findByRole("button", { name: /delete saved draft/i }))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))

    expect(onDelete).not.toHaveBeenCalled()
  })
})
