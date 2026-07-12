import { type ReactNode } from "react"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, userEvent } from "@/test"
import { OverlayComposerShell } from "./overlay-composer-shell"

beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
})

function renderShell(onOpenChange: () => void, extra?: ReactNode) {
  return render(
    <OverlayComposerShell open onOpenChange={onOpenChange} title="Editor" header={<div>header</div>}>
      {extra}
      <div contentEditable data-testid="editor" suppressContentEditableWarning />
    </OverlayComposerShell>
  )
}

describe("OverlayComposerShell Escape handling", () => {
  it("keeps the overlay open on Escape while the editor is focused, then closes once it is blurred", async () => {
    const onOpenChange = vi.fn()
    renderShell(onOpenChange)

    const editor = screen.getByTestId("editor")
    editor.focus()
    // First Escape with the editor focused: the editor owns it (blur), overlay stays open.
    await userEvent.keyboard("{Escape}")
    expect(onOpenChange).not.toHaveBeenCalled()

    // Focus leaves the editor (as blur-on-escape does); a second Escape closes.
    editor.blur()
    await userEvent.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("does not close when Escape dismisses an open suggestion list", async () => {
    const onOpenChange = vi.fn()
    renderShell(onOpenChange, <div role="listbox" aria-label="mentions" />)

    screen.getByTestId("editor").focus()
    await userEvent.keyboard("{Escape}")
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("closes on Escape when nothing in the editor is focused", async () => {
    const onOpenChange = vi.fn()
    renderShell(onOpenChange)
    // Close button inside the shell header is focusable but not contenteditable.
    screen.getByRole("button", { name: "Close editor" }).focus()
    await userEvent.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
