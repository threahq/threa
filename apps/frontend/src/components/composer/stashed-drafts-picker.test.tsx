import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, createEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StashedDraftsPicker } from "./stashed-drafts-picker"
import { FabDrawerCloseContext } from "./fab-drawer-close-context"
import { StashedDraftsComposerBridgeContext } from "./stashed-drafts-open-context"
import * as inputModeModule from "@/hooks/use-input-mode"
import type { CachedDraft, DraftPreview } from "@/hooks"

let isTouchMockValue = false

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
  const closeFabDrawer = vi.fn()
  const focusComposer = vi.fn()
  render(
    <TooltipProvider>
      <FabDrawerCloseContext.Provider value={closeFabDrawer}>
        <StashedDraftsComposerBridgeContext.Provider value={{ openRef: { current: null }, focusComposer }}>
          <StashedDraftsPicker {...props} />
        </StashedDraftsComposerBridgeContext.Provider>
      </FabDrawerCloseContext.Provider>
    </TooltipProvider>
  )
  return { ...props, closeFabDrawer, focusComposer }
}

describe("StashedDraftsPicker", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    isTouchMockValue = false
    vi.spyOn(inputModeModule, "useInputMode").mockImplementation(() => (isTouchMockValue ? "touch" : "mouse"))
  })

  it("keeps the editor focused when pressing popover buttons on touch", async () => {
    isTouchMockValue = true
    renderPicker()

    await userEvent.click(screen.getByRole("button", { name: /drafts/i }))

    const saveCurrent = screen.getByRole("button", { name: /save current/i })
    const mousedown = createEvent.mouseDown(saveCurrent)
    fireEvent(saveCurrent, mousedown)

    // preventDefault on mousedown stops focus leaving the editor (keyboard stays up).
    expect(mousedown.defaultPrevented).toBe(true)
  })

  it("does not suppress focus on fine-pointer devices where Radix manages it", async () => {
    isTouchMockValue = false
    renderPicker()

    await userEvent.click(screen.getByRole("button", { name: /drafts/i }))

    const saveCurrent = screen.getByRole("button", { name: /save current/i })
    const mousedown = createEvent.mouseDown(saveCurrent)
    fireEvent(saveCurrent, mousedown)

    expect(mousedown.defaultPrevented).toBe(false)
  })

  it("still fires button actions on click despite the mousedown guard", async () => {
    isTouchMockValue = true
    const onStashCurrent = vi.fn()
    const onRestore = vi.fn()
    renderPicker({ onStashCurrent, onRestore })

    await userEvent.click(screen.getByRole("button", { name: /drafts/i }))

    await userEvent.click(screen.getByRole("button", { name: /save current/i }))
    expect(onStashCurrent).toHaveBeenCalledOnce()

    // Save closes the popover; reopen it for the restore click.
    await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
    await userEvent.click(screen.getByText("Saved one"))
    expect(onRestore).toHaveBeenCalledWith("draft_1")
  })

  describe("close on action", () => {
    it("closes the popover and the hosting FAB drawer after Save current", async () => {
      const { onStashCurrent, closeFabDrawer } = renderPicker()

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(screen.getByRole("button", { name: /save current/i }))

      expect(onStashCurrent).toHaveBeenCalledOnce()
      await waitFor(() => expect(screen.queryByRole("button", { name: /save current/i })).not.toBeInTheDocument())
      expect(closeFabDrawer).toHaveBeenCalled()
    })

    it("closes the popover and the hosting FAB drawer after restoring a draft", async () => {
      const { onRestore, closeFabDrawer } = renderPicker()

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(screen.getByText("Saved one"))

      expect(onRestore).toHaveBeenCalledWith("draft_1")
      await waitFor(() => expect(screen.queryByText("Saved one")).not.toBeInTheDocument())
      expect(closeFabDrawer).toHaveBeenCalled()
    })

    it("focuses the composer after a restore instead of the trigger", async () => {
      const { focusComposer } = renderPicker()

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(screen.getByText("Saved one"))

      await waitFor(() => expect(focusComposer).toHaveBeenCalled())
      expect(screen.getByRole("button", { name: /drafts/i })).not.toHaveFocus()
    })
  })

  describe("keyboard navigation (desktop)", () => {
    it("focuses the first draft row on open and walks rows with ArrowUp/Down, Enter restores", async () => {
      isTouchMockValue = false
      const { onRestore } = renderPicker({
        drafts: [makeDraft("draft_1", "Saved one"), makeDraft("draft_2", "Saved two")],
      })

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))

      const rowOne = screen.getByText("Saved one").closest("button")!
      const rowTwo = screen.getByText("Saved two").closest("button")!
      expect(rowOne).toHaveFocus()

      await userEvent.keyboard("{ArrowDown}")
      expect(rowTwo).toHaveFocus()

      await userEvent.keyboard("{ArrowDown}")
      expect(rowOne).toHaveFocus()

      await userEvent.keyboard("{ArrowUp}")
      expect(rowTwo).toHaveFocus()

      await userEvent.keyboard("{Enter}")
      expect(onRestore).toHaveBeenCalledWith("draft_2")
    })
  })

  describe("preview rendering", () => {
    const sealed = makeDraft("draft_e", "placeholder")
    const open = () => userEvent.click(screen.getByRole("button", { name: /drafts/i }))
    const preview = (status: DraftPreview["status"], text = ""): Map<string, DraftPreview> =>
      new Map([["draft_e", { text, status }]])

    it("renders the host-supplied decrypted body when ready", async () => {
      renderPicker({ drafts: [sealed], previewById: preview("ready", "decrypted body") })
      await open()
      expect(screen.getByText("decrypted body")).toBeInTheDocument()
    })

    it("shows 'Decrypting…' while the body is in flight", async () => {
      renderPicker({ drafts: [sealed], previewById: preview("decrypting") })
      await open()
      expect(screen.getByText("Decrypting…")).toBeInTheDocument()
    })

    it("shows 'Encrypted draft' while the session is locked", async () => {
      renderPicker({ drafts: [sealed], previewById: preview("locked") })
      await open()
      expect(screen.getByText("Encrypted draft")).toBeInTheDocument()
    })

    it("shows 'Couldn't decrypt' on a failed decrypt", async () => {
      renderPicker({ drafts: [sealed], previewById: preview("failed") })
      await open()
      expect(screen.getByText("Couldn't decrypt")).toBeInTheDocument()
    })

    it("falls back to the plaintext body when no preview map is supplied", async () => {
      renderPicker({ drafts: [makeDraft("draft_p", "plain body")] })
      await open()
      expect(screen.getByText("plain body")).toBeInTheDocument()
    })
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
