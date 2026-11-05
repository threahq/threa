import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { DEFAULT_WORK_SCHEDULE, type WorkSchedule } from "@threahq/types"
import { WorkScheduleEditor } from "./work-schedule-editor"

const SPLIT_MONDAY: WorkSchedule = {
  days: {
    ...DEFAULT_WORK_SCHEDULE.days,
    1: [
      { start: "08:00", end: "11:00" },
      { start: "13:00", end: "17:00" },
    ],
  },
}

const FULL_MONDAY_LATE_TUESDAY: WorkSchedule = {
  days: {
    ...DEFAULT_WORK_SCHEDULE.days,
    1: ["06:00", "08:00", "10:00", "12:00", "14:00", "16:00"].map((start) => ({
      start,
      end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}:00`,
    })),
    2: [{ start: "16:00", end: "23:59" }],
  },
}

function Editor({ initial = SPLIT_MONDAY }: { initial?: WorkSchedule }) {
  const [schedule, setSchedule] = useState(initial)
  return <WorkScheduleEditor value={schedule} onChange={setSchedule} />
}

describe("WorkScheduleEditor", () => {
  it("keeps focus on the day while its shifts are removed, ending on the day's switch", async () => {
    const user = userEvent.setup()
    render(<Editor />)
    const focused = () => document.activeElement

    await user.click(screen.getByRole("button", { name: "Remove Monday shift 2" }))
    const afterSecond = focused()?.getAttribute("aria-label")
    await user.click(screen.getByRole("button", { name: "Remove Monday shift" }))

    expect({ afterSecond, afterAll: focused() }).toEqual({
      afterSecond: "Remove Monday shift",
      afterAll: screen.getByRole("switch", { name: "Monday" }),
    })
  })

  it("keeps Add shift in reach on a day that takes no more, saying why", async () => {
    const user = userEvent.setup()
    render(<Editor initial={FULL_MONDAY_LATE_TUESDAY} />)
    const monday = screen.getByRole("button", { name: "Add a shift on Monday" })
    const tuesday = screen.getByRole("button", { name: "Add a shift on Tuesday" })
    await user.click(monday)
    await user.click(tuesday)

    expect({
      states: [monday, tuesday].map((button) => ({
        disabled: button.hasAttribute("disabled"),
        ariaDisabled: button.getAttribute("aria-disabled"),
        reason: document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
      })),
      shifts: [
        screen.getAllByRole("button", { name: /^Remove Monday shift/ }).length,
        screen.getAllByRole("button", { name: /^Remove Tuesday shift/ }).length,
      ],
      wednesday: screen.getByRole("button", { name: "Add a shift on Wednesday" }).hasAttribute("aria-disabled"),
    }).toEqual({
      states: [
        { disabled: false, ariaDisabled: "true", reason: "A day holds up to 6 shifts. Remove one to add another." },
        {
          disabled: false,
          ariaDisabled: "true",
          reason: "The last shift runs to the end of the day. End it earlier to add another.",
        },
      ],
      shifts: [6, 1],
      wednesday: false,
    })
  })
})
