import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, createEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DEFAULT_WORK_SCHEDULE } from "@threa/types"
import { spyOnExport } from "@/test/spy"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ScheduledMessagesPicker } from "./scheduled-messages-picker"
import { StashedDraftsComposerBridgeContext } from "./stashed-drafts-open-context"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as hooks from "@/hooks"
import * as workScheduleModule from "@/hooks/use-work-schedule"
import * as contexts from "@/contexts"
import * as editDialogModule from "@/components/scheduled/scheduled-edit-dialog"

let isTouchMockValue = true

function renderPicker() {
  const onSchedule = vi.fn()
  const result = render(
    <TooltipProvider>
      <ScheduledMessagesPicker workspaceId="ws_1" streamId="stream_1" canSchedule onSchedule={onSchedule} />
    </TooltipProvider>
  )
  return { ...result, onSchedule }
}

describe("ScheduledMessagesPicker", () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    isTouchMockValue = true
    vi.spyOn(inputModeModule, "useInputMode").mockImplementation(() => (isTouchMockValue ? "touch" : "mouse"))
    spyOnExport(hooks, "useScheduledList").mockReturnValue((() => ({ items: [] })) as never)
    spyOnExport(hooks, "useCancelScheduled").mockReturnValue((() => ({ mutate: vi.fn() })) as never)
    spyOnExport(hooks, "useSendScheduledNow").mockReturnValue((() => ({ mutate: vi.fn() })) as never)
    vi.spyOn(workScheduleModule, "useEffectiveWorkSchedule").mockReturnValue(DEFAULT_WORK_SCHEDULE)
    spyOnExport(contexts, "usePreferencesOptional").mockReturnValue((() => null) as never)
    // Always-mounted edit dialog pulls in a deep react-query hook tree; stub it.
    spyOnExport(editDialogModule, "ScheduledEditDialog").mockReturnValue((() => null) as never)
  })

  it("publishes its pending count to the composer, and clears it on unmount", () => {
    // The phone foot hides this trigger and its dot, so the count has to reach
    // the composer's + through the bridge.
    spyOnExport(hooks, "useScheduledList").mockReturnValue((() => ({
      items: [{ id: "sched_1" }, { id: "sched_2" }],
    })) as never)
    const reportScheduledCount = vi.fn()
    const { unmount } = render(
      <TooltipProvider>
        <StashedDraftsComposerBridgeContext.Provider
          value={{
            openRef: { current: null },
            openScheduledRef: { current: null },
            reportScheduledCount,
            focusComposer: vi.fn(),
          }}
        >
          <ScheduledMessagesPicker workspaceId="ws_1" streamId="stream_1" canSchedule onSchedule={vi.fn()} />
        </StashedDraftsComposerBridgeContext.Provider>
      </TooltipProvider>
    )

    expect(reportScheduledCount).toHaveBeenLastCalledWith(2)
    unmount()
    expect(reportScheduledCount).toHaveBeenLastCalledWith(0)
  })

  it("lets the date/time inputs take focus while guarding the action buttons (touch)", async () => {
    renderPicker()

    await userEvent.click(screen.getByRole("button", { name: /scheduled/i }))
    await userEvent.click(screen.getByRole("button", { name: /schedule send/i }))
    await userEvent.click(screen.getByRole("button", { name: /pick a time/i }))

    // Native date input must keep native focus so its platform picker opens.
    // (PopoverContent is portaled to document.body, not the render container.)
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement
    expect(dateInput).toBeTruthy()
    const dateMousedown = createEvent.mouseDown(dateInput)
    fireEvent(dateInput, dateMousedown)
    expect(dateMousedown.defaultPrevented).toBe(false)

    // The Schedule button is a plain button — focus stays on the editor.
    const scheduleBtn = screen.getByRole("button", { name: /^schedule$/i })
    const btnMousedown = createEvent.mouseDown(scheduleBtn)
    fireEvent(scheduleBtn, btnMousedown)
    expect(btnMousedown.defaultPrevented).toBe(true)
  })

  it("does not guard focus on fine-pointer devices", async () => {
    isTouchMockValue = false
    renderPicker()

    await userEvent.click(screen.getByRole("button", { name: /scheduled/i }))
    const scheduleSend = screen.getByRole("button", { name: /schedule send/i })
    const mousedown = createEvent.mouseDown(scheduleSend)
    fireEvent(scheduleSend, mousedown)

    expect(mousedown.defaultPrevented).toBe(false)
  })

  it("schedules with the custom duration", async () => {
    const before = Date.now()
    const { onSchedule } = renderPicker()

    await userEvent.click(screen.getByRole("button", { name: /scheduled/i }))
    await userEvent.click(screen.getByRole("button", { name: /schedule send/i }))
    await userEvent.click(screen.getByRole("button", { name: /custom duration/i }))
    await userEvent.clear(screen.getByRole("spinbutton", { name: /custom duration/i }))
    await userEvent.type(screen.getByRole("spinbutton", { name: /custom duration/i }), "30")
    await userEvent.click(screen.getByRole("button", { name: /^schedule$/i }))

    const scheduledAt = onSchedule.mock.calls[0]?.[0] as Date
    expect(scheduledAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000)
    expect(scheduledAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000)
  })

  it("stays open through the picking flow and closes only once a time is picked", async () => {
    const { onSchedule } = renderPicker()

    await userEvent.click(screen.getByRole("button", { name: /scheduled/i }))
    await userEvent.click(screen.getByRole("button", { name: /schedule send/i }))

    // Mode switch is NOT the end of the flow — nothing closes yet.
    expect(screen.getByRole("button", { name: /pick a time/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /custom duration/i }))
    expect(screen.getByRole("button", { name: /^schedule$/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /^schedule$/i }))

    expect(onSchedule).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole("button", { name: /pick a time/i })).not.toBeInTheDocument())
  })
})
