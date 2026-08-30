import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect, useState } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { EditorActionBar, type EditorFormatFoot } from "./editor-action-bar"
import * as contextsModule from "@/contexts"

function renderBar(props: Partial<React.ComponentProps<typeof EditorActionBar>> = {}) {
  const editorHandle = {
    focus: vi.fn(),
    focusAfterQuoteReply: vi.fn(),
    insertMention: vi.fn(),
    insertSlash: vi.fn(),
    insertEmoji: vi.fn(),
    openSnippetEditor: vi.fn(),
    insertFiles: vi.fn(() => true),
    cancelPendingInlineUpload: vi.fn(),
    removeAttachmentReferences: vi.fn(),
    insertTranscribedText: vi.fn(),
    setDictationInterim: vi.fn(),
    insertDictationChunk: vi.fn(),
    replaceDictationChunkText: vi.fn(() => true),
    lockDictationChunk: vi.fn(),
    lockAllDictationChunks: vi.fn(),
    getDictationChunkText: vi.fn(() => null),
    getEditor: vi.fn(() => null),
  }

  const onFormatOpenChange = vi.fn()
  const onMobileExpandedChange = vi.fn()
  const onDesktopExpandClick = vi.fn()

  const bar = (override: Partial<React.ComponentProps<typeof EditorActionBar>>) => (
    <TooltipProvider>
      <EditorActionBar
        editorHandle={editorHandle}
        formatOpen={false}
        onFormatOpenChange={onFormatOpenChange}
        onMobileExpandedChange={onMobileExpandedChange}
        onDesktopExpandClick={onDesktopExpandClick}
        trailingContent={<button type="button">Send</button>}
        {...props}
        {...override}
      />
    </TooltipProvider>
  )
  const { rerender } = render(bar({}))

  return {
    editorHandle,
    onFormatOpenChange,
    onMobileExpandedChange,
    onDesktopExpandClick,
    rerender: (override: Partial<React.ComponentProps<typeof EditorActionBar>>) => rerender(bar(override)),
  }
}

describe("EditorActionBar", () => {
  it("supports keyboard activation for the format toggle", async () => {
    const user = userEvent.setup()
    const { onFormatOpenChange } = renderBar({ showExpand: false, showAttach: false })

    const button = screen.getByRole("button", { name: "Formatting" })
    button.focus()
    await user.keyboard("{Enter}")

    expect(onFormatOpenChange).toHaveBeenCalledWith(true)
  })

  it("supports keyboard activation for insert mention", async () => {
    const user = userEvent.setup()
    const { editorHandle } = renderBar({ showExpand: false, showAttach: false })

    const button = screen.getByRole("button", { name: "Insert mention" })
    button.focus()
    await user.keyboard("{Enter}")

    expect(editorHandle.insertMention).toHaveBeenCalled()
  })

  it("supports pointer activation for mobile expand", async () => {
    const user = userEvent.setup()
    const { onMobileExpandedChange } = renderBar({ mobileExpanded: false, showAttach: false })

    await user.click(screen.getByRole("button", { name: "Expand editor" }))

    expect(onMobileExpandedChange).toHaveBeenCalledWith(true)
  })

  it("supports pointer activation for desktop expand", async () => {
    const user = userEvent.setup()
    const { onDesktopExpandClick } = renderBar({
      showExpand: false,
      showAttach: false,
      showDesktopExpand: true,
    })

    await user.click(screen.getByRole("button", { name: "Expand to fullscreen editor" }))

    expect(onDesktopExpandClick).toHaveBeenCalled()
  })
})

describe("action side", () => {
  // The mirror is a flex-direction flip, so the class on the row is the only
  // signal jsdom can see — it has no layout to measure.
  const row = () => screen.getByRole("button", { name: "Formatting" }).parentElement

  it("keeps the row in source order by default", () => {
    renderBar()
    expect(row()).not.toHaveClass("flex-row-reverse")
  })

  it("mirrors the row so Send lands on the left", () => {
    renderBar({ side: "left" })
    expect(row()).toHaveClass("flex-row-reverse")
  })

  describe("folded (phone foot)", () => {
    beforeEach(() => {
      vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
        preferences: { keyboardShortcuts: {} },
        isLoading: false,
      } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    })
    const folded = (): EditorFormatFoot => ({
      chromeId: "composer-a",
      editor: null,
      linkPopoverOpen: false,
      onLinkPopoverOpenChange: vi.fn(),
      sendButton: <button type="button">Send</button>,
    })

    it("rests as Aa · + · trailing, with everything else behind the + menu", async () => {
      const user = userEvent.setup()
      const { onFormatOpenChange } = renderBar({
        formatFoot: folded(),
        footMenu: { onAttach: vi.fn(), onOpenAside: vi.fn(), onSchedule: vi.fn(), onOpenDrafts: vi.fn() },
      })

      for (const name of ["Insert emoji", "Insert mention", "Expand editor", "Attach files", "Open an aside"]) {
        expect(screen.queryByRole("button", { name })).toBeNull()
      }
      expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Formatting" }))
      expect(onFormatOpenChange).toHaveBeenCalledWith(true)
    })

    it("acts from the + menu rows without moving focus off the editor, and closes after each row", async () => {
      const user = userEvent.setup()
      const editorEl = document.createElement("div")
      editorEl.contentEditable = "true"
      editorEl.tabIndex = 0
      document.body.appendChild(editorEl)
      editorEl.focus()
      const footMenu = { onAttach: vi.fn(), onOpenAside: vi.fn(), onSchedule: vi.fn(), onOpenDrafts: vi.fn() }
      const onMobileExpandedChange = vi.fn()
      renderBar({ formatFoot: folded(), footMenu, onMobileExpandedChange })

      const rows: Array<[string, () => unknown]> = [
        ["Attach files", () => expect(footMenu.onAttach).toHaveBeenCalled()],
        ["Open an aside", () => expect(footMenu.onOpenAside).toHaveBeenCalled()],
        ["Schedule", () => expect(footMenu.onSchedule).toHaveBeenCalled()],
        ["Drafts", () => expect(footMenu.onOpenDrafts).toHaveBeenCalled()],
        ["Expand editor", () => expect(onMobileExpandedChange).toHaveBeenCalledWith(true)],
      ]
      for (const [name, assertCalled] of rows) {
        await user.click(screen.getByRole("button", { name: "More" }))
        await user.click(screen.getByRole("button", { name }))
        assertCalled()
        expect(screen.queryByTestId("composer-foot-menu")).toBeNull()
        expect(document.activeElement).toBe(editorEl)
      }
      editorEl.remove()
    })

    it("disables the + menu rows along with the bar", async () => {
      const user = userEvent.setup()
      renderBar({ formatFoot: folded(), footMenu: { onAttach: vi.fn(), onSchedule: vi.fn() }, disabled: true })
      expect(screen.getByRole("button", { name: "More" })).toBeDisabled()
      expect(screen.getByRole("button", { name: "Formatting" })).toBeDisabled()
      await user.click(screen.getByRole("button", { name: "More" }))
      expect(screen.queryByTestId("composer-foot-menu")).toBeNull()
    })

    it("swaps the row for the marks while formatting, with Aa lit and the trailing slot after them", () => {
      renderBar({ formatFoot: folded(), footMenu: { onAttach: vi.fn() }, formatOpen: true })

      expect(screen.getByRole("button", { name: "Formatting" })).toHaveAttribute("aria-pressed", "true")
      expect(screen.queryByRole("button", { name: "More" })).toBeNull()
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
    })

    it("slides the marks out before the rest of the foot returns", () => {
      vi.useFakeTimers()
      try {
        const { rerender } = renderBar({ formatFoot: folded(), footMenu: { onAttach: vi.fn() }, formatOpen: true })
        rerender({ formatOpen: false })

        expect(screen.getByRole("button", { name: "Formatting" })).toHaveAttribute("aria-pressed", "false")
        expect(screen.queryByRole("button", { name: "More" })).toBeNull()
        expect(document.querySelector(".animate-out")).not.toBeNull()

        act(() => vi.advanceTimersByTime(200))
        expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument()
        expect(document.querySelector(".animate-out")).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it("stamps the + menu with the owning composer's id", async () => {
      const user = userEvent.setup()
      renderBar({ formatFoot: folded(), footMenu: { onAttach: vi.fn() } })

      await user.click(screen.getByRole("button", { name: "More" }))

      expect(screen.getByTestId("composer-foot-menu")).toHaveAttribute("data-composer-chrome", "composer-a")
    })

    it("keeps the trailing slot mounted (hidden) while formatting, so a mic take survives Aa", async () => {
      const mounts = vi.fn()
      function Mic() {
        const [takes, setTakes] = useState(0)
        useEffect(() => {
          mounts()
          setTakes(1)
        }, [])
        return <button type="button" aria-label="Dictate" data-takes={takes} />
      }
      const props = { formatFoot: folded(), footMenu: { onAttach: vi.fn() }, trailingContent: <Mic /> }
      const { rerender } = render(
        <TooltipProvider>
          <EditorActionBar editorHandle={null} formatOpen={false} onFormatOpenChange={vi.fn()} {...props} />
        </TooltipProvider>
      )
      expect(screen.getByRole("button", { name: "Dictate" })).toBeVisible()

      rerender(
        <TooltipProvider>
          <EditorActionBar editorHandle={null} formatOpen onFormatOpenChange={vi.fn()} {...props} />
        </TooltipProvider>
      )
      const mic = screen.getByRole("button", { name: "Dictate", hidden: true })
      expect(mic).not.toBeVisible()
      expect(mic).toHaveAttribute("data-takes", "1")

      rerender(
        <TooltipProvider>
          <EditorActionBar editorHandle={null} formatOpen={false} onFormatOpenChange={vi.fn()} {...props} />
        </TooltipProvider>
      )
      // Still hidden behind the marks' slide-out, then back, never remounted.
      expect(screen.getByRole("button", { name: "Dictate", hidden: true })).not.toBeVisible()
      await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toBeVisible())
      expect(mounts).toHaveBeenCalledTimes(1)
    })
  })
})
