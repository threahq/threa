import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, createEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StashedDraftsPicker } from "./stashed-drafts-picker"
import { FabDrawerCloseContext } from "./fab-drawer-close-context"
import { StashedDraftsComposerBridgeContext } from "./stashed-drafts-open-context"
import * as inputModeModule from "@/hooks/use-input-mode"
import type { CachedDraft, DraftPreview, StashedDraftRowOrigin } from "@/hooks"

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
  const tree = (pickerProps: typeof props) => (
    <TooltipProvider>
      <FabDrawerCloseContext.Provider value={closeFabDrawer}>
        <StashedDraftsComposerBridgeContext.Provider value={{ openRef: { current: null }, focusComposer }}>
          <StashedDraftsPicker {...pickerProps} />
        </StashedDraftsComposerBridgeContext.Provider>
      </FabDrawerCloseContext.Provider>
    </TooltipProvider>
  )
  const { rerender, unmount } = render(tree(props))
  const rerenderWith = (next: Partial<typeof props>) => rerender(tree({ ...props, ...next }))
  return { ...props, closeFabDrawer, focusComposer, rerenderWith, unmount }
}

describe("StashedDraftsPicker", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    isTouchMockValue = false
    vi.spyOn(inputModeModule, "useInputMode").mockImplementation(() => (isTouchMockValue ? "touch" : "mouse"))
    vi.spyOn(toast, "error").mockReturnValue("" as ReturnType<typeof toast.error>)
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

    // Closing + focusing the composer IS the success signal (INV-63), so a
    // refused restore that still closes reads as "it worked" while nothing
    // happened. Every reason gets its own message.
    it.each([
      ["missing", "no longer there"],
      ["checked-out", "open in another composer"],
      ["host-ineligible", "can't hold that draft"],
      ["raced", "moved before it could be restored"],
    ] as const)("says why a %s restore did nothing and keeps the picker open", async (reason, message) => {
      const onRestore = vi.fn().mockResolvedValue({ ok: false, reason })
      const { closeFabDrawer, focusComposer } = renderPicker({ onRestore })

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(screen.getByText("Saved one"))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(message)))
      expect(screen.getByText("Saved one")).toBeInTheDocument()
      expect(closeFabDrawer).not.toHaveBeenCalled()
      expect(focusComposer).not.toHaveBeenCalled()
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
      new Map([["draft_e", { text, markdown: text, status }]])

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

  describe("origin and the own/borrowed seam", () => {
    const open = () => userEvent.click(screen.getByRole("button", { name: /drafts/i }))
    const own: StashedDraftRowOrigin = { tier: "own", label: "#general" }
    const borrowed = (label: string): StashedDraftRowOrigin => ({ tier: "borrowed", label })
    const rows = [makeDraft("draft_own", "mine"), makeDraft("draft_borrowed", "theirs")]

    it("draws the seam between the last own row and the first borrowed one", async () => {
      renderPicker({
        drafts: rows,
        originById: new Map([
          ["draft_own", own],
          ["draft_borrowed", borrowed("Reply in Pizza plans")],
        ]),
      })
      await open()

      const items = Array.from(screen.getByRole("list").children).map((el) => el.textContent)
      expect(items[0]).toContain("mine")
      expect(items[1]).toContain("From elsewhere")
      expect(items[2]).toContain("theirs")
    })

    it("renders no seam when every row is own", async () => {
      renderPicker({
        drafts: rows,
        originById: new Map([
          ["draft_own", own],
          ["draft_borrowed", own],
        ]),
      })
      await open()
      expect(screen.queryByTestId("stashed-drafts-borrowed-separator")).toBeNull()
    })

    it("names where a borrowed row came from, and says nothing on an own row", async () => {
      renderPicker({
        drafts: rows,
        originById: new Map([
          ["draft_own", own],
          ["draft_borrowed", borrowed("Reply in Pizza plans")],
        ]),
      })
      await open()

      const origins = screen.getAllByText(/Reply in Pizza plans|#general/)
      expect(origins.map((el) => el.textContent)).toEqual(["Reply in Pizza plans"])
    })

    // The two fixed-height classes ARE the INV-21 story for this row: the preview
    // reserves two lines so a decrypting body cannot grow it, and the meta line is
    // a fixed height so a late-resolving origin can only truncate. Assert them
    // directly — a count-vs-itself comparison stays green with both deleted, which
    // is worse than no test because it reads as coverage.
    it("marks an all-borrowed pile as from elsewhere — the pile this feature exists for", async () => {
      // A channel composer with no stashed draft of its own is exactly where a
      // conversation's draft surfaces, so requiring a preceding own row left the
      // modal case with no cue at all.
      renderPicker({
        drafts: rows,
        originById: new Map([
          ["draft_own", borrowed("Reply in Pizza plans")],
          ["draft_borrowed", borrowed("Reply in Pizza plans")],
        ]),
      })
      await open()

      expect(screen.getAllByTestId("stashed-drafts-borrowed-separator")).toHaveLength(1)
    })

    it("tells the user a borrowed row will change where the composer files", async () => {
      renderPicker({
        drafts: rows,
        originById: new Map([
          ["draft_own", own],
          ["draft_borrowed", borrowed("Reply in Pizza plans")],
        ]),
      })
      await open()

      const borrowedRow = screen.getAllByText("theirs")[0]!.closest("button")!
      expect(borrowedRow.getAttribute("aria-label")).toContain("changes where this composer files")
      // An own row carries no such warning — nothing moves when you pick it.
      const ownRow = screen.getAllByText("mine")[0]!.closest("button")!
      expect(ownRow.getAttribute("aria-label")).toBeNull()
    })

    it("holds the row's geometry classes, and adding an origin does not add a line", async () => {
      const { rerenderWith } = renderPicker({
        drafts: rows,
        // The borrowed row has NO origin entry yet — the state before the label
        // resolves, which is the transition that actually happens.
        originById: new Map([["draft_own", own]]),
      })
      await open()

      const row = () => screen.getAllByText("theirs")[0]!.closest("button")!
      const paragraphs = () => Array.from(row().querySelectorAll("p"))

      const before = paragraphs()
      expect(before).toHaveLength(2)
      // A plaintext row's preview is final at first paint, so it does NOT pay the
      // reserved second line — that cost only buys something for a sealed row.
      expect(before[0]!.className).not.toContain("min-h-10")
      expect(before[0]!.className).toContain("line-clamp-2")
      expect(before[1]!.className).toContain("h-4")

      rerenderWith({
        drafts: rows,
        originById: new Map([
          ["draft_own", own],
          ["draft_borrowed", borrowed("Reply in Pizza plans")],
        ]),
      })

      expect(screen.getByText("Reply in Pizza plans")).toBeInTheDocument()
      const after = paragraphs()
      // The origin shares the meta line rather than adding a third paragraph.
      expect(after).toHaveLength(2)
      expect(after[0]!.className).toContain("line-clamp-2")
      expect(after[1]!.className).toContain("h-4")
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
