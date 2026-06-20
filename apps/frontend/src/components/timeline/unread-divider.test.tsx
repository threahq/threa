import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { UnreadDivider } from "./unread-divider"
import { addEscapeUnreadListener } from "@/lib/mark-read-events"

afterEach(cleanup)

describe("UnreadDivider", () => {
  it("renders a 'Mark all read' control when a streamId is given", () => {
    render(<UnreadDivider streamId="stream_1" />)
    expect(screen.getByRole("button", { name: /mark all read/i })).toBeInTheDocument()
  })

  it("omits the control when no streamId is given (e.g. drafts)", () => {
    render(<UnreadDivider />)
    expect(screen.queryByRole("button", { name: /mark all read/i })).toBeNull()
  })

  it("dispatches escape-unread for its stream when the ✕ is clicked", () => {
    const listener = vi.fn()
    const unsubscribe = addEscapeUnreadListener(listener)

    render(<UnreadDivider streamId="stream_42" />)
    fireEvent.click(screen.getByRole("button", { name: /mark all read/i }))

    expect(listener).toHaveBeenCalledWith({ streamId: "stream_42" })
    unsubscribe()
  })
})
