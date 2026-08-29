import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, fireEvent, createEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { toast } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StashedDraftsPicker } from "./stashed-drafts-picker"
import { StashedDraftsComposerBridgeContext } from "./stashed-drafts-open-context"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as replyOpenStore from "@/stores/conversation-reply-open-store"
import type { CachedDraft, DraftPreview, StashedDraftRowOrigin } from "@/hooks"
import type { DraftRestoreResult } from "@/lib/drafts/restore-refusal"

function LocationEcho() {
  const location = useLocation()
  return <div data-testid="navigated-away">{`${location.pathname}${location.search}`}</div>
}

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
  const focusComposer = vi.fn()
  const tree = (pickerProps: typeof props) => (
    <MemoryRouter initialEntries={["/start"]}>
      <TooltipProvider>
        <StashedDraftsComposerBridgeContext.Provider
          value={{ openRef: { current: null }, openScheduledRef: { current: null }, focusComposer }}
        >
          <StashedDraftsPicker {...pickerProps} />
        </StashedDraftsComposerBridgeContext.Provider>
      </TooltipProvider>
      <Routes>
        <Route path="/start" element={null} />
        {/* A navigate row landing anywhere else renders this marker with the
            exact location, so tests bind the destination, not just "moved". */}
        <Route path="*" element={<LocationEcho />} />
      </Routes>
    </MemoryRouter>
  )
  const { rerender, unmount } = render(tree(props))
  const rerenderWith = (next: Partial<typeof props>) => rerender(tree({ ...props, ...next }))
  return { ...props, focusComposer, rerenderWith, unmount }
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
    it("closes the popover after Save current", async () => {
      const { onStashCurrent } = renderPicker()

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(screen.getByRole("button", { name: /save current/i }))

      expect(onStashCurrent).toHaveBeenCalledOnce()
      await waitFor(() => expect(screen.queryByRole("button", { name: /save current/i })).not.toBeInTheDocument())
    })

    it("closes the popover after restoring a draft", async () => {
      const { onRestore } = renderPicker()

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(screen.getByText("Saved one"))

      expect(onRestore).toHaveBeenCalledWith("draft_1")
      await waitFor(() => expect(screen.queryByText("Saved one")).not.toBeInTheDocument())
    })

    // Closing + focusing the composer IS the success signal (INV-63), so a
    // refused restore that still closes reads as "it worked" while nothing
    // happened. Every reason gets its own message.
    it.each([
      ["missing", "no longer there"],
      ["host-ineligible", "can't hold that draft"],
      ["raced", "moved before it could be restored"],
    ] as const)("says why a %s restore did nothing and keeps the picker open", async (reason, message) => {
      const onRestore = vi.fn().mockResolvedValue({ ok: false, reason })
      const { focusComposer } = renderPicker({ onRestore })

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(screen.getByText("Saved one"))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(message)))
      expect(screen.getByText("Saved one")).toBeInTheDocument()
      expect(focusComposer).not.toHaveBeenCalled()
    })

    it("focuses the composer after a restore instead of the trigger", async () => {
      const { focusComposer } = renderPicker()

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(screen.getByText("Saved one"))

      await waitFor(() => expect(focusComposer).toHaveBeenCalled())
      expect(screen.getByRole("button", { name: /drafts/i })).not.toHaveFocus()
    })

    it("holds one pile presentation until an in-flight restore closes it", async () => {
      const row = makeDraft("draft_1", "Saved one")
      const borrowed = {
        tier: "borrowed",
        label: "Reply in Pizza plans",
        checkedOutElsewhere: false,
        openHref: null,
        openConversationId: null,
        openCarriesDraft: false,
      } as StashedDraftRowOrigin
      let finishRestore!: (result: DraftRestoreResult) => void
      const onRestore = vi.fn(
        () =>
          new Promise<DraftRestoreResult>((resolve) => {
            finishRestore = resolve
          })
      )
      const { rerenderWith } = renderPicker({
        drafts: [row],
        originById: new Map([[row.id, borrowed]]),
        onRestore,
      })

      await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
      await userEvent.click(screen.getByText("Saved one"))
      await waitFor(() => expect(onRestore).toHaveBeenCalledWith(row.id))

      rerenderWith({
        drafts: [{ ...row, scope: "board:reply:conv_1" }],
        originById: new Map([
          [
            row.id,
            {
              tier: "own",
              label: "#general",
              checkedOutElsewhere: false,
              openHref: null,
              openConversationId: null,
              openCarriesDraft: false,
            } as StashedDraftRowOrigin,
          ],
        ]),
      })
      expect(screen.getByTestId("stashed-drafts-borrowed-separator")).toBeInTheDocument()
      expect(screen.getByText("Reply in Pizza plans")).toBeInTheDocument()

      rerenderWith({ drafts: [], originById: new Map() })
      expect(screen.getByText("Saved one")).toBeInTheDocument()
      expect(screen.queryByText(/No saved drafts yet/)).not.toBeInTheDocument()

      await act(async () => finishRestore({ ok: true }))
      await waitFor(() => expect(screen.queryByText("Saved one")).not.toBeInTheDocument())
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
    const preview = (status: DraftPreview["status"], text = "", attachmentCount = 0): Map<string, DraftPreview> =>
      new Map([["draft_e", { text, markdown: text, attachmentCount, status }]])

    it("renders the host-supplied decrypted body when ready", async () => {
      renderPicker({ drafts: [sealed], previewById: preview("ready", "decrypted body") })
      await open()
      expect(screen.getByText("decrypted body")).toBeInTheDocument()
    })

    it("names the files of a decrypted attachment-only draft, not 'Empty draft'", async () => {
      // A sealed row's `attachments` is [] at rest (E2EE-4) — the count has to
      // come from the same decrypt the body did.
      renderPicker({ drafts: [sealed], previewById: preview("ready", "", 2) })
      await open()
      expect(screen.getByText("2 attachments")).toBeInTheDocument()
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
    const own: StashedDraftRowOrigin = {
      tier: "own",
      label: "#general",
      checkedOutElsewhere: false,
      openHref: null,
      openConversationId: null,
      openCarriesDraft: false,
    }
    const borrowed = (
      label: string,
      checkedOutElsewhere = false,
      openHref: string | null = null
    ): StashedDraftRowOrigin => ({
      tier: "borrowed",
      label,
      checkedOutElsewhere,
      openHref,
      openConversationId: openHref ? "conv_1" : null,
      openCarriesDraft: openHref !== null,
    })
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

    it("hints a row checked out by another composer, without gating it", async () => {
      renderPicker({
        drafts: rows,
        originById: new Map([
          ["draft_own", own],
          ["draft_borrowed", borrowed("Reply in Pizza plans", true)],
        ]),
      })
      await open()

      const items = Array.from(screen.getByRole("list").children).map((el) => el.textContent)
      // Control: the un-checked-out row carries no hint.
      expect(items[0]).not.toContain("open elsewhere")
      expect(items[2]).toContain("open elsewhere")
      // Still a live action, not a disabled row.
      expect(screen.getByText("theirs").closest("button")).not.toBeDisabled()
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

describe("navigate rows (branch replies / mounted composers)", () => {
  const open = () => userEvent.click(screen.getByRole("button", { name: /drafts/i }))

  it("navigates instead of restoring, closes the picker, and says so in the meta line", async () => {
    const replyOpenSpy = vi.spyOn(replyOpenStore, "requestConversationReplyOpen")
    const onRestore = vi.fn()
    renderPicker({
      drafts: [makeDraft("draft_nav", "branch body"), makeDraft("draft_plain", "plain body")],
      originById: new Map<string, StashedDraftRowOrigin>([
        [
          "draft_nav",
          {
            tier: "borrowed",
            label: "Reply in Pizza plans",
            checkedOutElsewhere: false,
            openHref: "/w/ws_1/s/stream_1?panel=conv%3Aconv_1&stash=draft_nav",
            openConversationId: "conv_1",
            openCarriesDraft: true,
          },
        ],
        [
          "draft_plain",
          {
            tier: "borrowed",
            label: "#general",
            checkedOutElsewhere: false,
            openHref: null,
            openConversationId: null,
            openCarriesDraft: false,
          },
        ],
      ]),
      onRestore,
    })
    await open()

    // Scoped to the NAVIGATE row (not a join over all rows): the badge must sit
    // on the branch row and stay off the control row.
    const navRow = screen.getByText("branch body").closest("li")
    const plainRow = screen.getByText("plain body").closest("li")
    expect(navRow?.textContent).toContain("opens there")
    expect(plainRow?.textContent).not.toContain("opens there")

    await userEvent.click(screen.getByText("branch body"))

    // Navigation, not restore: the row never reaches the restore path, and it
    // lands EXACTLY on the row's href (path + panel + stash param), not merely
    // "somewhere else".
    expect(onRestore).not.toHaveBeenCalled()
    const landed = await screen.findByTestId("navigated-away")
    expect(landed.textContent).toBe("/w/ws_1/s/stream_1?panel=conv%3Aconv_1&stash=draft_nav")
    // Arrival focus rides the reply-open store — a same-URL navigation is a
    // router no-op, so without this the tap can be a silent nothing.
    expect(replyOpenSpy).toHaveBeenCalledWith("conv_1")
  })

  it("says 'pick the draft up' for the manual-pickup fallback instead of promising its own composer", async () => {
    renderPicker({
      drafts: [makeDraft("draft_fb", "orphan branch")],
      originById: new Map<string, StashedDraftRowOrigin>([
        [
          "draft_fb",
          {
            tier: "borrowed",
            label: "Reply in Pizza plans",
            checkedOutElsewhere: false,
            openHref: "/w/ws_1/board?panel=conv%3Aconv_orphan",
            openConversationId: "conv_orphan",
            openCarriesDraft: false,
          },
        ],
      ]),
    })
    await userEvent.click(screen.getByRole("button", { name: /drafts/i }))

    const row = screen.getByText("orphan branch").closest("button")!
    expect(row.getAttribute("aria-label")).toContain("pick the draft up")
    expect(row.getAttribute("aria-label")).not.toContain("its own composer")
  })

  it("a throwing restore toasts and keeps the picker open — never a silent no-op", async () => {
    const onRestore = vi.fn().mockRejectedValue(new Error("navigate row reached restore"))
    renderPicker({
      drafts: [makeDraft("draft_boom", "drifting row")],
      onRestore,
    })
    await userEvent.click(screen.getByRole("button", { name: /drafts/i }))
    await userEvent.click(screen.getByText("drifting row"))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("could not be restored")))
    expect(screen.getByText("drifting row")).toBeInTheDocument()
  })

  it("a control row without openHref still restores", async () => {
    const onRestore = vi.fn().mockResolvedValue({ ok: true })
    renderPicker({
      drafts: [makeDraft("draft_plain", "plain body")],
      originById: new Map<string, StashedDraftRowOrigin>([
        [
          "draft_plain",
          {
            tier: "borrowed",
            label: "#general",
            checkedOutElsewhere: false,
            openHref: null,
            openConversationId: null,
            openCarriesDraft: false,
          },
        ],
      ]),
      onRestore,
    })
    await open()
    await userEvent.click(screen.getByText("plain body"))
    expect(onRestore).toHaveBeenCalledWith("draft_plain")
  })
})
