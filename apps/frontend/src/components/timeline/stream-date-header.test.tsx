import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StreamDateHeader } from "./stream-date-header"
import { localStartOfDayMs } from "@/lib/dates"

describe("StreamDateHeader", () => {
  const todayMs = localStartOfDayMs(new Date())

  it("renders nothing when the day is unknown", () => {
    const { container } = render(<StreamDateHeader dayStartMs={null} visible onJumpToDate={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it("labels the pill with the topmost visible day", () => {
    render(<StreamDateHeader dayStartMs={todayMs} visible onJumpToDate={() => {}} />)
    expect(screen.getByRole("button", { name: /jump to date/i })).toHaveTextContent("Today")
  })

  it("jumps to a preset's date when chosen", async () => {
    const user = userEvent.setup()
    const onJumpToDate = vi.fn()
    render(<StreamDateHeader dayStartMs={todayMs} visible onJumpToDate={onJumpToDate} />)

    await user.click(screen.getByRole("button", { name: /jump to date/i }))
    await user.click(screen.getByRole("button", { name: "Yesterday" }))

    expect(onJumpToDate).toHaveBeenCalledTimes(1)
    const [date] = onJumpToDate.mock.calls[0]
    // The "Yesterday" preset resolves to ~24h before now.
    const dayDiff = Math.round((Date.now() - (date as Date).getTime()) / 86_400_000)
    expect(dayDiff).toBe(1)
  })

  it("reveals the calendar from the jump menu", async () => {
    const user = userEvent.setup()
    render(<StreamDateHeader dayStartMs={todayMs} visible onJumpToDate={() => {}} />)

    await user.click(screen.getByRole("button", { name: /jump to date/i }))
    expect(screen.queryByRole("grid")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /jump to a specific date/i }))
    // react-day-picker renders the month grid as a table with role="grid".
    expect(screen.getByRole("grid")).toBeInTheDocument()
  })
})
