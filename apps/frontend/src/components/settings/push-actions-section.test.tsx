import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PushAction } from "@threahq/types"
import { PushActionsSection, assignSlot } from "./push-actions-section"
import * as contextsModule from "@/contexts"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as reactionEmojiPickerModule from "@/components/timeline/reaction-emoji-picker"

const WS = "ws_1"

function stubNotification(maxActions: number | undefined) {
  if (maxActions === undefined) {
    Reflect.deleteProperty(globalThis, "Notification")
    return
  }
  Object.defineProperty(globalThis, "Notification", { value: { maxActions }, configurable: true, writable: true })
}

function mount(prefs: { pushActions?: PushAction[]; pushReminderMinutes?: number; pushQuickReaction?: string }) {
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
  vi.spyOn(reactionEmojiPickerModule, "ReactionEmojiPicker").mockImplementation(({ onSelect, trigger }) => (
    <div>
      {trigger}
      <button type="button" onClick={() => onSelect("🎉")}>
        choose party
      </button>
    </div>
  ))
  render(<PushActionsSection workspaceId={WS} />)
  return { updatePreference }
}

function previewButtons(): string[] {
  const preview = screen.getByLabelText("Notification preview")
  return within(preview)
    .getAllByRole("listitem")
    .map((node) => node.textContent ?? "")
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

  it("only explains where buttons appear when this device cannot show them", () => {
    stubNotification(0)
    mount({})
    expect(screen.getByText(/This device can't show buttons/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Notification preview")).not.toBeInTheDocument()
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

  it("commits the reminder duration in minutes on blur and clamps it to a week", async () => {
    const user = userEvent.setup()
    const { updatePreference } = mount({ pushReminderMinutes: 120 })
    const amount = screen.getByRole("spinbutton", { name: "Reminder amount" })
    expect(amount).toHaveValue(2)
    expect(screen.getByRole("combobox", { name: "Reminder unit" })).toHaveTextContent("hours")
    await user.clear(amount)
    await user.type(amount, "3")
    await user.tab()
    expect(updatePreference).toHaveBeenCalledWith("pushReminderMinutes", 180)
    await user.clear(amount)
    await user.type(amount, "999")
    await user.tab()
    expect(updatePreference).toHaveBeenCalledWith("pushReminderMinutes", 7 * 24 * 60)
  })
})

describe("assignSlot", () => {
  it("moves an action between slots instead of repeating it", () => {
    expect(assignSlot(["mark_read", "remind"], 1, "mark_read")).toEqual(["mark_read"])
    expect(assignSlot(["mark_read", "remind"], 0, "remind")).toEqual(["remind"])
    expect(assignSlot(["mark_read"], 1, "react")).toEqual(["mark_read", "react"])
    expect(assignSlot(["mark_read", "remind"], 0, null)).toEqual(["remind"])
  })
})
