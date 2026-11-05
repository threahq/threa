import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MessagesSettings } from "./messages-settings"
import { settingDef } from "./settings-registry"
import * as contextsModule from "@/contexts"

function mount(prefs: Record<string, unknown>) {
  const updatePreference = vi.fn()
  const updatePreferences = vi.fn()
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { ...prefs, accessibility: {} },
    updatePreference,
    updatePreferences,
    isLoading: false,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  render(<MessagesSettings />)
  return { updatePreference, updatePreferences }
}

function edit(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } })
  fireEvent.blur(field)
}

const codeFold = () => within(screen.getByRole("radiogroup", { name: settingDef("code-collapse").label }))

describe("MessagesSettings — folding code blocks", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("turns folding off with Never, and Always or a height turns it back on", async () => {
    const user = userEvent.setup()
    const { updatePreferences } = mount({ codeBlockCollapseEnabled: true, codeBlockCollapseThreshold: 12 })

    await user.click(codeFold().getByRole("radio", { name: "Never" }))
    await user.click(codeFold().getByRole("radio", { name: "Always" }))

    expect(updatePreferences.mock.calls).toEqual([
      [{ codeBlockCollapseEnabled: false, codeBlockCollapseThreshold: 12 }],
      [{ codeBlockCollapseEnabled: true, codeBlockCollapseThreshold: 0 }],
    ])
  })

  it("shows Never as picked when folding is off, keeping the last height for Taller than", async () => {
    const user = userEvent.setup()
    const { updatePreferences } = mount({ codeBlockCollapseEnabled: false, codeBlockCollapseThreshold: 12 })

    expect(codeFold().getByRole("radio", { name: "Never" })).toHaveAttribute("data-state", "checked")
    await user.click(codeFold().getByRole("radio", { name: "Taller than" }))

    expect(updatePreferences.mock.calls).toEqual([[{ codeBlockCollapseEnabled: true, codeBlockCollapseThreshold: 12 }]])
  })

  it("picks Taller than in the same write as a valid height typed under Never", () => {
    const { updatePreferences } = mount({ codeBlockCollapseEnabled: false, codeBlockCollapseThreshold: 12 })
    edit(screen.getByRole("spinbutton", { name: settingDef("code-collapse-at").label }), "20")

    expect(updatePreferences.mock.calls).toEqual([[{ codeBlockCollapseEnabled: true, codeBlockCollapseThreshold: 20 }]])
  })

  it("leaves Never picked when the height is cleared and Escape pressed, or typed out of range", () => {
    const { updatePreferences } = mount({ codeBlockCollapseEnabled: false, codeBlockCollapseThreshold: 12 })
    const height = screen.getByRole("spinbutton", { name: settingDef("code-collapse-at").label })
    fireEvent.change(height, { target: { value: "" } })
    fireEvent.keyDown(height, { key: "Escape" })
    const afterEscape = { value: (height as HTMLInputElement).value, writes: updatePreferences.mock.calls.length }
    edit(height, "9999")

    expect({
      afterEscape,
      writes: updatePreferences.mock.calls,
      never: codeFold().getByRole("radio", { name: "Never" }).getAttribute("data-state"),
    }).toEqual({ afterEscape: { value: "12", writes: 0 }, writes: [], never: "checked" })
  })

  it("marks the height as not in effect until Taller than is picked", () => {
    const notice = () => document.getElementById("setting-code-collapse-at-notice")?.textContent ?? null
    const height = () => screen.getByRole("spinbutton", { name: settingDef("code-collapse-at").label })
    mount({ codeBlockCollapseEnabled: false, codeBlockCollapseThreshold: 12 })
    const underNever = height().getAttribute("aria-describedby")?.includes("setting-code-collapse-at-notice")
    const noticeUnderNever = notice()
    cleanup()
    mount({ codeBlockCollapseEnabled: true, codeBlockCollapseThreshold: 12 })

    expect({ underNever, noticeUnderNever, noticeUnderTaller: notice() }).toEqual({
      underNever: true,
      noticeUnderNever: "Applies when “Taller than” is chosen.",
      noticeUnderTaller: null,
    })
  })
})

describe("MessagesSettings — one fold shape", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("describes each fold by its chosen option alone, worded alike, with no description on the height rows", () => {
    mount({
      messageCollapseEnabled: false,
      codeBlockCollapseEnabled: true,
      codeBlockCollapseThreshold: 0,
      blockquoteCollapseEnabled: true,
      blockquoteCollapseThreshold: 6,
    })
    const describe = (setting: "message-collapse" | "code-collapse" | "quote-collapse") => {
      const group = screen.getByRole("radiogroup", { name: settingDef(setting).label })
      return {
        options: within(group)
          .getAllByRole("radio")
          .map((radio) => radio.textContent),
        description: document.getElementById(group.getAttribute("aria-describedby")!)?.textContent,
      }
    }
    const heightDescriptions = (["message-collapse-at", "code-collapse-at", "quote-collapse-at"] as const).map(
      (setting) => document.getElementById(`setting-${setting}-description`)?.textContent ?? null
    )

    expect({
      message: describe("message-collapse"),
      code: describe("code-collapse"),
      quote: describe("quote-collapse"),
      heightDescriptions,
    }).toEqual({
      message: { options: ["Never", "Taller than"], description: "Every message opens in full." },
      code: { options: ["Never", "Always", "Taller than"], description: "Every code block starts collapsed." },
      quote: {
        options: ["Never", "Always", "Taller than"],
        description: "Quotes over the limit below start collapsed.",
      },
      heightDescriptions: [null, null, null],
    })
  })
})

describe("MessagesSettings — folding long messages", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("picks Taller than in the same write as a valid fold height typed under Never", () => {
    const { updatePreference, updatePreferences } = mount({
      messageCollapseEnabled: false,
      messageCollapseAtHeight: 600,
      messageCollapseToHeight: 300,
    })
    edit(screen.getByRole("spinbutton", { name: settingDef("message-collapse-at").label }), "500")

    expect({ picked: updatePreference.mock.calls, heights: updatePreferences.mock.calls }).toEqual({
      picked: [],
      heights: [[{ messageCollapseEnabled: true, messageCollapseAtHeight: 500, messageCollapseToHeight: 300 }]],
    })
  })

  it("leaves Never picked when the fold height is typed out of range", () => {
    const { updatePreference, updatePreferences } = mount({
      messageCollapseEnabled: false,
      messageCollapseAtHeight: 600,
      messageCollapseToHeight: 300,
    })
    edit(screen.getByRole("spinbutton", { name: settingDef("message-collapse-at").label }), "5")

    expect({ picked: updatePreference.mock.calls, heights: updatePreferences.mock.calls }).toEqual({
      picked: [],
      heights: [],
    })
  })
})
