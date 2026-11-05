import type { ComponentProps } from "react"
import { spyOnExport } from "@/test/spy"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PrefNotificationLevel, PushAction } from "@threahq/types"
import type { PushDeviceState } from "@/hooks/push-device-state"
import { PushActionsSection, assignSlot } from "./push-actions-section"
import * as contextsModule from "@/contexts"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as reactionEmojiPickerModule from "@/components/timeline/reaction-emoji-picker"
import * as pointerModule from "@/hooks/use-pointer"

const WS = "ws_1"

function stubNotification(maxActions: number | undefined) {
  if (maxActions === undefined) {
    Reflect.deleteProperty(globalThis, "Notification")
    return
  }
  Object.defineProperty(globalThis, "Notification", { value: { maxActions }, configurable: true, writable: true })
}

function mount(
  prefs: { pushActions?: PushAction[]; pushReminderMinutes?: number; pushQuickReaction?: string },
  { level = "all", pushDevice = "on" }: { level?: PrefNotificationLevel; pushDevice?: PushDeviceState } = {}
) {
  const updatePreference = vi.fn()
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { ...prefs, accessibility: {} },
    updatePreference,
    updatePreferences: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(authModule, "useAuth").mockReturnValue({ user: { id: "workos_1" } } as unknown as ReturnType<
    typeof authModule.useAuth
  >)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
    { id: "usr_1", workosUserId: "workos_1", name: "Kris", avatarUrl: "avatars/ws_1/usr_1/1700" },
  ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
  spyOnExport(reactionEmojiPickerModule, "ReactionEmojiPicker").mockReturnValue((({
    onSelect,
    trigger,
  }: ComponentProps<typeof reactionEmojiPickerModule.ReactionEmojiPicker>) => (
    <div>
      {trigger}
      <button type="button" onClick={() => onSelect("🎉")}>
        choose party
      </button>
    </div>
  )) as unknown as typeof reactionEmojiPickerModule.ReactionEmojiPicker)
  render(<PushActionsSection workspaceId={WS} level={level} pushDevice={pushDevice} />)
  return { updatePreference }
}

function previewButtons(): string[] {
  const preview = screen.getByLabelText("Notification preview")
  return within(preview)
    .getAllByRole("listitem")
    .map((node) => node.textContent ?? "")
}

/** The row while the buttons can't show: its trigger's state and name, and the controls still reachable. */
function unavailableRow() {
  const trigger = screen.getByRole("button", { name: /^Notification buttons/ })
  return {
    disabled: trigger.getAttribute("aria-disabled"),
    expanded: trigger.getAttribute("aria-expanded"),
    name: trigger.textContent,
    selects: screen.queryAllByRole("combobox").length,
  }
}

describe("PushActionsSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    stubNotification(2)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    stubNotification(undefined)
  })

  it("starts folded on a phone behind a summary of the chosen buttons, and opens on tap", async () => {
    vi.spyOn(pointerModule, "useIsMobileOrCoarse").mockReturnValue(true)
    const user = userEvent.setup()
    mount({ pushActions: ["mark_read", "remind"] })
    const trigger = screen.getByRole("button", { name: /^Notification buttons/ })
    const folded = {
      expanded: trigger.getAttribute("aria-expanded"),
      summary: trigger.textContent,
      selects: screen.queryAllByRole("combobox").length,
    }

    await user.click(trigger)

    expect({ folded, openSelects: screen.getAllByRole("combobox").length }).toEqual({
      folded: { expanded: "false", summary: "Notification buttonsMark read, Remind me", selects: 0 },
      openSelects: 3,
    })
  })

  it("stays shut with the reason when this device cannot show them", async () => {
    stubNotification(0)
    const user = userEvent.setup()
    mount({ pushActions: ["mark_read"] })
    await user.tab()
    await user.keyboard("{Enter}")

    expect({ focused: document.activeElement?.textContent, row: unavailableRow() }).toEqual({
      focused: "Notification buttonsOnly shown in desktop Chrome.Mark read",
      row: {
        disabled: "true",
        expanded: "false",
        name: "Notification buttonsOnly shown in desktop Chrome.Mark read",
        selects: 0,
      },
    })
  })

  it("hides the settings on Android, which reports buttons it cannot attribute", () => {
    // jsdom defines userAgent on the prototype, so restoring means removing the
    // own property this stub adds, not putting a captured descriptor back.
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/140.0.0.0 Mobile Safari/537.36",
    })
    try {
      mount({})
      expect(unavailableRow()).toMatchObject({ disabled: "true", selects: 0 })
      expect(unavailableRow().name).toContain("Only shown in desktop Chrome.")
    } finally {
      Reflect.deleteProperty(navigator, "userAgent")
    }
  })

  it("previews the default Mark read + 5m reminder card as the current user", () => {
    mount({})
    const preview = screen.getByLabelText("Notification preview")
    expect(within(preview).getByText("general")).toBeInTheDocument()
    expect(within(preview).getByText("Kris: Lunch at noon?")).toBeInTheDocument()
    expect(previewButtons()).toEqual(["Mark read", "Remind me in 5m"])
    expect(within(preview).getByText("K")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "First button" })).toHaveTextContent("Mark read")
    expect(screen.getByRole("combobox", { name: "Second button" })).toHaveTextContent("Remind me")
  })

  it("writes the second slot as React and previews the chosen emoji", async () => {
    const user = userEvent.setup()
    const { updatePreference } = mount({ pushActions: ["mark_read", "react"], pushQuickReaction: "🚀" })
    expect(previewButtons()).toEqual(["Mark read", "🚀"])
    await user.click(screen.getByRole("combobox", { name: "First button" }))
    await user.click(await screen.findByRole("option", { name: "Remind me" }))
    expect(updatePreference).toHaveBeenCalledWith("pushActions", ["remind", "react"])
  })

  it("emptying a slot drops it and the emoji picker writes the quick reaction", async () => {
    const user = userEvent.setup()
    const { updatePreference } = mount({ pushActions: ["mark_read", "react"] })
    await user.click(screen.getByRole("combobox", { name: "First button" }))
    await user.click(await screen.findByRole("option", { name: "None" }))
    expect(updatePreference).toHaveBeenCalledWith("pushActions", ["react"])
    await user.click(screen.getByRole("button", { name: "choose party" }))
    expect(updatePreference).toHaveBeenCalledWith("pushQuickReaction", "🎉")
  })

  it("writes the picked reminder duration in minutes", async () => {
    const user = userEvent.setup()
    const { updatePreference } = mount({ pushReminderMinutes: 180 })
    expect(screen.getByRole("combobox", { name: "Remind me after" })).toHaveTextContent("3 hours")
    await user.click(screen.getByRole("combobox", { name: "Remind me after" }))
    await user.click(await screen.findByRole("option", { name: "1 day" }))
    expect(updatePreference).toHaveBeenCalledWith("pushReminderMinutes", 24 * 60)
  })
})

describe("assignSlot", () => {
  it("moves an action between slots instead of repeating it", () => {
    expect(assignSlot(["mark_read", "remind"], 1, "mark_read")).toEqual(["mark_read"])
    expect(assignSlot(["mark_read", "remind"], 0, "remind")).toEqual(["remind"])
    expect(assignSlot(["mark_read"], 1, "react")).toEqual(["mark_read", "react"])
    expect(assignSlot(["mark_read", "remind"], 0, null)).toEqual(["remind"])
  })

  it("names what has to change while no pushes are sent", () => {
    stubNotification(2)
    mount({}, { level: "none" })

    expect(unavailableRow().name).toBe(
      "Notification buttonsShown once “Push notifications” isn't “No push”.Mark read, Remind me"
    )
  })

  it("should stay editable with push off on this device, since the buttons sync to the others", async () => {
    stubNotification(2)
    const user = userEvent.setup()
    const { updatePreference } = mount({}, { pushDevice: "blocked" })
    const row = unavailableRow()
    await user.click(screen.getByRole("combobox", { name: "First button" }))
    await user.click(await screen.findByRole("option", { name: "React" }))

    expect({
      row,
      note: screen.getByText(/Quick actions on a notification/).textContent,
      writes: updatePreference.mock.calls,
    }).toEqual({
      row: { disabled: null, expanded: "true", name: "Notification buttonsMark read, Remind me", selects: 3 },
      note: "Quick actions on a notification. Shown once “Push on this device” is on.",
      writes: [["pushActions", ["react", "remind"]]],
    })
  })
})
