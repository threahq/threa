import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { WorkSchedule, WorkspaceBootstrap } from "@threahq/types"
import * as contexts from "@/contexts"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { DateTimeSettings } from "./datetime-settings"
import { ScheduleSettings } from "./schedule-settings"
import { settingDef } from "./settings-registry"

const WS = "ws_1"
const updatePreference = vi.fn().mockResolvedValue(undefined)
const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

const workspaceHours: WorkSchedule = {
  days: {
    0: [],
    1: [{ start: "08:00", end: "16:00" }],
    2: [{ start: "08:00", end: "16:00" }],
    3: [{ start: "08:00", end: "16:00" }],
    4: [{ start: "08:00", end: "16:00" }],
    5: [{ start: "08:00", end: "12:00" }],
    6: [],
  },
}

function mount(ui: ReactNode, preferences: Record<string, unknown>) {
  const preferencesValue = { preferences, updatePreference, isLoading: false }
  vi.spyOn(contexts, "usePreferences").mockReturnValue(
    preferencesValue as unknown as ReturnType<typeof contexts.usePreferences>
  )
  vi.spyOn(contexts, "usePreferencesOptional").mockReturnValue(
    preferencesValue as unknown as ReturnType<typeof contexts.usePreferencesOptional>
  )
  const queryClient = new QueryClient()
  queryClient.setQueryData(workspaceKeys.bootstrap(WS), {
    workspaceSettings: { defaultWorkSchedule: workspaceHours },
  } as unknown as WorkspaceBootstrap)
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/w/${WS}`]}>
        <Routes>
          <Route path="/w/:workspaceId" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  updatePreference.mockClear()
})

describe("DateTimeSettings", () => {
  it("writes the clock and date format", async () => {
    const user = userEvent.setup()
    mount(<DateTimeSettings />, { timezone: deviceTimezone, timeFormat: "24h", dateFormat: "YYYY-MM-DD" })

    await user.click(screen.getByRole("radio", { name: "2:30 PM" }))
    await user.click(screen.getByRole("combobox", { name: settingDef("date-format").label }))
    await user.click(screen.getByRole("option", { name: "31/01/2026" }))

    expect(updatePreference.mock.calls).toEqual([
      ["timeFormat", "12h"],
      ["dateFormat", "DD/MM/YYYY"],
    ])
  })

  it("offers this device's time zone when the saved one differs", async () => {
    const user = userEvent.setup()
    const saved = deviceTimezone === "Pacific/Auckland" ? "Europe/Stockholm" : "Pacific/Auckland"
    mount(<DateTimeSettings />, { timezone: saved })

    const deviceLabel = deviceTimezone.replace(/_/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    expect(screen.getByText(new RegExp(`^${deviceLabel} \\(`))).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Use this device's time zone" }))

    expect(updatePreference).toHaveBeenCalledWith("timezone", deviceTimezone)
  })

  it("hides the device shortcut when the zones already match", () => {
    mount(<DateTimeSettings />, { timezone: deviceTimezone })

    expect(screen.queryByRole("button", { name: "Use this device's time zone" })).toBeNull()
  })
})

async function openWorkingHours(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${settingDef("working-hours").label}`) }))
}

describe("ScheduleSettings", () => {
  it("shows the workspace's hours read-only in the user's clock and customizes from them", async () => {
    const user = userEvent.setup()
    mount(<ScheduleSettings />, { workSchedule: null, timeFormat: "12h" })

    const trigger = screen.getByRole("button", { name: new RegExp(`^${settingDef("working-hours").label}`) })
    expect(trigger).toHaveTextContent("Workspace hours · Mon–Thu 8:00 AM–4:00 PM · Fri 8:00 AM–12:00 PM")
    await user.click(trigger)
    expect(screen.getByText("Using the workspace's hours.")).toBeInTheDocument()
    expect(screen.queryByRole("combobox")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Customize working hours" }))

    expect(updatePreference).toHaveBeenCalledWith("workSchedule", workspaceHours)
  })

  it("edits personal hours with times in the user's clock and saves each change", async () => {
    const user = userEvent.setup()
    mount(<ScheduleSettings />, { workSchedule: workspaceHours, timeFormat: "12h" })
    await openWorkingHours(user)

    const start = screen.getByRole("combobox", { name: "Monday shift start" })
    expect(start).toHaveTextContent("8:00 AM")
    await user.click(start)
    await user.click(screen.getByRole("option", { name: "9:30 AM" }))

    expect(updatePreference).toHaveBeenLastCalledWith("workSchedule", {
      days: { ...workspaceHours.days, 1: [{ start: "09:30", end: "16:00" }] },
    })
  })

  it("carries the end along when the start moves past it", async () => {
    const user = userEvent.setup()
    mount(<ScheduleSettings />, { workSchedule: workspaceHours, timeFormat: "24h" })
    await openWorkingHours(user)

    await user.click(screen.getByRole("combobox", { name: "Friday shift start" }))
    await user.click(screen.getByRole("option", { name: "13:00" }))

    expect(updatePreference).toHaveBeenLastCalledWith("workSchedule", {
      days: { ...workspaceHours.days, 5: [{ start: "13:00", end: "17:00" }] },
    })
  })

  it("keeps a saved time that is off the quarter-hour grid", async () => {
    const user = userEvent.setup()
    mount(<ScheduleSettings />, {
      workSchedule: { days: { ...workspaceHours.days, 1: [{ start: "08:10", end: "16:00" }] } },
      timeFormat: "24h",
    })
    await openWorkingHours(user)

    expect(screen.getByRole("combobox", { name: "Monday shift start" })).toHaveTextContent("08:10")
  })

  it("goes back to the workspace's hours", async () => {
    const user = userEvent.setup()
    mount(<ScheduleSettings />, { workSchedule: workspaceHours })
    await openWorkingHours(user)

    await user.click(screen.getByRole("button", { name: "Use the workspace's hours" }))

    expect(updatePreference).toHaveBeenCalledWith("workSchedule", null)
  })
})
