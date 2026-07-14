import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CollapsedComposerBar, COLLAPSED_COMPOSER_SHADOW } from "./collapsed-composer-bar"
import type { ScopeDraftPreview } from "@/hooks"

describe("CollapsedComposerBar", () => {
  it("renders the placeholder as a single tappable bar carrying the baseline collapsed-composer classes", async () => {
    const onClick = vi.fn()
    render(<CollapsedComposerBar placeholder="Write a reply…" onClick={onClick} />)

    const bar = screen.getByRole("button", { name: "Write a reply…" })
    // Same card + shadow + row metrics as MessageComposer's own collapsed bar,
    // so the resting invitation reads as the same object as the live composer.
    expect(bar.className).toContain("rounded-[16px]")
    expect(bar.className).toContain("border-input")
    expect(bar.className).toContain("bg-card")
    expect(bar.className).toContain(COLLAPSED_COMPOSER_SHADOW)
    expect(bar.querySelector(".min-h-\\[30px\\]")).not.toBeNull()

    await userEvent.click(bar)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("shows the draft's first line with the pencil marker instead of the placeholder", () => {
    const draft: ScopeDraftPreview = {
      draftId: "draft_1",
      preview: "half-written thought",
      attachmentCount: 0,
      isCheckedOut: true,
    }
    render(<CollapsedComposerBar draft={draft} placeholder="Write a reply…" onClick={vi.fn()} />)

    expect(screen.getByText("half-written thought")).toBeTruthy()
    expect(screen.getByLabelText("Unsent draft")).toBeTruthy()
    expect(screen.queryByText("Write a reply…")).toBeNull()
  })

  it("has no send button — it mounts the real composer on tap, it does not send in place", () => {
    render(<CollapsedComposerBar placeholder="Write a reply…" onClick={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull()
  })
})
