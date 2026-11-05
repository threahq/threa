import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { UserPreferences, WorkSchedule } from "@threahq/types"
import { render, screen, userEvent } from "@/test"
import * as contextsModule from "@/contexts"
import { QuietHoursSetting, quietHoursState } from "./quiet-hours-setting"

const EMPTY: WorkSchedule = { days: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } }
const MONDAY_EARLY: WorkSchedule = { days: { ...EMPTY.days, 1: [{ start: "08:00", end: "16:00" }] } }

function mount(preferences: Partial<UserPreferences>) {
  const updatePreference = vi.fn()
  const context = {
    preferences,
    updatePreference,
    updatePreferences: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.usePreferences>
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue(context)
  vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue(context)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/w/ws_1?settings=notifications"]}>
        <contextsModule.SettingsProvider>
          <QuietHoursSetting workspaceId="ws_1" />
        </contextsModule.SettingsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { updatePreference }
}

describe("QuietHoursSetting", () => {
  afterEach(() => vi.restoreAllMocks())

  it("turns quiet hours on from its switch", async () => {
    const { updatePreference } = mount({ quietOutsideWorkingHours: false })
    await userEvent.click(screen.getByRole("switch", { name: "Quiet outside working hours" }))
    expect(updatePreference).toHaveBeenCalledWith("quietOutsideWorkingHours", true)
  })

  it.each([
    ["the workspace default", null, "Mon–Fri 09:00–17:00 · workspace default"],
    ["your own hours", MONDAY_EARLY, "Mon 08:00–16:00 · your hours"],
  ])("shows the hours it follows from %s", (_, workSchedule, shown) => {
    mount({ quietOutsideWorkingHours: false, timeFormat: "24h", workSchedule })
    const switchControl = screen.getByRole("switch", { name: "Quiet outside working hours" })
    const description = document.getElementById(switchControl.getAttribute("aria-describedby")!.split(" ")[0]!)
    expect(description?.querySelector("[data-slot=quiet-hours-schedule]")?.textContent).toBe(shown)
  })

  it("says nothing extra while there are working hours", () => {
    mount({ quietOutsideWorkingHours: true, workSchedule: null })
    expect(screen.queryByText(/stay off all week/)).not.toBeInTheDocument()
  })

  it("says push stays off all week when there are no working hours", () => {
    mount({ quietOutsideWorkingHours: true, workSchedule: EMPTY })
    expect(screen.getByText("You have no working hours, so push notifications stay off all week.")).toBeInTheDocument()
  })

  it("says it's quiet now and when it resumes, on this device's clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 10, 2, 7, 30))
    mount({ quietOutsideWorkingHours: true, timeFormat: "24h", workSchedule: MONDAY_EARLY })
    const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, " ")

    expect(document.querySelector("[data-slot=quiet-hours-now]")?.textContent).toBe(
      `Quiet now · resumes 08:00 · ${deviceZone} time, from this device`
    )
    vi.useRealTimers()
  })
})

describe("quietHoursState", () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const split: WorkSchedule = {
    days: {
      ...EMPTY.days,
      1: [
        { start: "08:00", end: "12:00" },
        { start: "12:00", end: "16:00" },
      ],
    },
  }

  it.each([
    ["before the day starts", new Date(2026, 10, 2, 7, 0), { quiet: true, changesAt: new Date(2026, 10, 2, 8, 0) }],
    [
      "across back-to-back shifts",
      new Date(2026, 10, 2, 9, 0),
      { quiet: false, changesAt: new Date(2026, 10, 2, 16, 0) },
    ],
    ["after the last shift", new Date(2026, 10, 2, 17, 0), { quiet: true, changesAt: new Date(2026, 10, 9, 8, 0) }],
  ])("finds the next change %s", (_, now, expected) => {
    expect(quietHoursState(split, now, zone)).toEqual(expected)
  })

  it("never changes without working hours", () => {
    expect(quietHoursState(EMPTY, new Date(2026, 10, 2, 9, 0), zone)).toEqual({ quiet: true, changesAt: null })
  })
})
