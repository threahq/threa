import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, createEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StashedDraftsPicker } from "./stashed-drafts-picker"
import * as useMobileModule from "@/hooks/use-mobile"
import type { CachedDraft } from "@/hooks"

let isMobileMockValue = false

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

function renderPicker(overrides: Partial<Parameters<typeof StashedDraftsPicker>[0]> = {}) {
  const props = {
    drafts: [makeDraft("draft_1", "Saved one")],
    canStashCurrent: true,
    onStashCurrent: vi.fn(),
    onRestore: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }
  render(
    <TooltipProvider>
      <StashedDraftsPicker {...props} />
    </TooltipProvider>
  )
  return props
}

describe("StashedDraftsPicker", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    isMobileMockValue = false
    vi.spyOn(useMobileModule, "useIsMobile").mockImplementation(() => isMobileMockValue)
  })

  it("keeps the editor focused when pressing popover buttons on mobile", async () => {
    isMobileMockValue = true
    renderPicker()

    await userEvent.click(screen.getByRole("button", { name: /drafts/i }))

    const saveCurrent = screen.getByRole("button", { name: /save current/i })
    const mousedown = createEvent.mouseDown(saveCurrent)
    fireEvent(saveCurrent, mousedown)

    // preventDefault on mousedown stops focus leaving the editor (keyboard stays up).
    expect(mousedown.defaultPrevented).toBe(true)
  })

  it("does not suppress focus on desktop where Radix manages it", async () => {
    isMobileMockValue = false
    renderPicker()

    await userEvent.click(screen.getByRole("button", { name: /drafts/i }))

    const saveCurrent = screen.getByRole("button", { name: /save current/i })
    const mousedown = createEvent.mouseDown(saveCurrent)
    fireEvent(saveCurrent, mousedown)

    expect(mousedown.defaultPrevented).toBe(false)
  })

  it("still fires button actions on click despite the mousedown guard", async () => {
    isMobileMockValue = true
    const onStashCurrent = vi.fn()
    const onRestore = vi.fn()
    renderPicker({ onStashCurrent, onRestore })

    await userEvent.click(screen.getByRole("button", { name: /drafts/i }))

    await userEvent.click(screen.getByRole("button", { name: /save current/i }))
    expect(onStashCurrent).toHaveBeenCalledOnce()

    await userEvent.click(screen.getByText("Saved one"))
    expect(onRestore).toHaveBeenCalledWith("draft_1")
  })

  describe("delete confirmation", () => {
    it("guards the delete behind a confirm dialog, firing onDelete only after confirming", async () => {
      const onDelete = vi.fn()
      renderPicker({ onDelete })

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(await screen.findByRole("button", { name: /delete saved draft/i }))

      // The trash icon does NOT delete immediately — same guard as the Drafts explorer.
      expect(onDelete).not.toHaveBeenCalled()
      expect(await screen.findByText("Delete this draft?")).toBeInTheDocument()

      await userEvent.click(screen.getByRole("button", { name: "Delete" }))
      expect(onDelete).toHaveBeenCalledWith("draft_1")
    })

    it("does not delete when the confirm is cancelled", async () => {
      const onDelete = vi.fn()
      renderPicker({ onDelete })

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(await screen.findByRole("button", { name: /delete saved draft/i }))
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }))

      expect(onDelete).not.toHaveBeenCalled()
    })
  })
})
