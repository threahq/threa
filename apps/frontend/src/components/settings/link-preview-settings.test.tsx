import { useSyncExternalStore } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DEFAULT_LINK_PREVIEW_OPEN_COUNT, type LinkPreviewLimit } from "@threahq/types"
import { MemoryRouter } from "react-router-dom"
import * as contexts from "@/contexts"
import { SettingsProvider } from "@/contexts/settings-context"
import { LinkPreviewSettings } from "./link-preview-settings"

const updatePreferences = vi.fn().mockResolvedValue(undefined)

function mockPreferences(
  linkPreviewOpenCount: LinkPreviewLimit,
  linkPreviewTypeOverrides: Record<string, LinkPreviewLimit> = {}
) {
  vi.spyOn(contexts, "usePreferences").mockReturnValue({
    preferences: { linkPreviewDefault: "open", linkPreviewOpenCount, linkPreviewTypeOverrides },
    updatePreferences,
    isLoading: false,
  } as unknown as ReturnType<typeof contexts.usePreferences>)
}

async function choose(user: ReturnType<typeof userEvent.setup>, group: string, option: string) {
  if (group === "Previews to expand") {
    await user.click(within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name: option }))
    return
  }
  if (!screen.queryByRole("combobox", { name: group })) {
    await user.click(screen.getByRole("button", { name: /By link type/ }))
  }
  await user.click(screen.getByRole("combobox", { name: group }))
  await user.click(screen.getByRole("option", { name: option }))
}

/** Preferences that take each write, as the provider's optimistic update does. */
function livePreferences(initial: Record<string, unknown>) {
  let preferences = { linkPreviewTypeOverrides: {}, ...initial }
  const listeners = new Set<() => void>()
  const write = vi.fn(async (input: Record<string, unknown>) => {
    preferences = { ...preferences, ...input }
    for (const listener of listeners) listener()
  })
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  vi.spyOn(contexts, "usePreferences").mockImplementation(
    () =>
      ({
        preferences: useSyncExternalStore(subscribe, () => preferences),
        updatePreferences: write,
        isLoading: false,
      }) as unknown as ReturnType<typeof contexts.usePreferences>
  )
  return write
}

const countInput = () => screen.getByRole("spinbutton", { name: "Previews to expand, how many" })

beforeEach(() => {
  vi.restoreAllMocks()
  updatePreferences.mockClear()
  mockPreferences(3)
})

describe("LinkPreviewSettings", () => {
  it("offers None, First [N] and All as one radio list, with the count on First", () => {
    mockPreferences("all")
    render(<LinkPreviewSettings />)
    const group = screen.getByRole("radiogroup", { name: "Previews to expand" })

    expect({
      names: within(group)
        .getAllByRole("radio")
        .map((radio) => document.getElementById(radio.getAttribute("aria-labelledby") ?? "")?.textContent),
      countInGroup: within(group).queryByRole("spinbutton") !== null,
      unit: document.getElementById(`${countInput().id}-unit`)?.textContent,
      editableWhileAll: !countInput().hasAttribute("disabled"),
    }).toEqual({ names: ["None", "First", "All"], countInGroup: true, unit: "previews", editableWhileAll: true })
  })

  it.each([
    ["All", { linkPreviewDefault: "open", linkPreviewOpenCount: "all" }],
    ["None", { linkPreviewDefault: "collapsed", linkPreviewOpenCount: 3 }],
  ] as const)("should pick First with the count typed while %s is chosen, and keep it", async (_, saved) => {
    const writes = livePreferences(saved)
    render(<LinkPreviewSettings />)
    fireEvent.change(countInput(), { target: { value: "5" } })
    fireEvent.blur(countInput())

    await waitFor(() =>
      expect({
        writes: writes.mock.calls,
        field: countInput().getAttribute("value"),
        first: within(screen.getByRole("radiogroup", { name: "Previews to expand" }))
          .getByRole("radio", { name: "First" })
          .getAttribute("data-state"),
      }).toEqual({
        writes: [[{ linkPreviewDefault: "open", linkPreviewOpenCount: 5 }]],
        field: "5",
        first: "checked",
      })
    )
  })

  it("moves focus into the count without changing the choice", async () => {
    mockPreferences("all")
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    await user.click(
      within(screen.getByRole("radiogroup", { name: "Previews to expand" })).getByRole("radio", { name: "All" })
    )
    updatePreferences.mockClear()
    await user.tab({ shift: true })

    expect({ focused: document.activeElement === countInput(), writes: updatePreferences.mock.calls }).toEqual({
      focused: true,
      writes: [],
    })
  })

  it("should save none without replacing the last positive count", async () => {
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    await choose(user, "Previews to expand", "None")
    expect(updatePreferences.mock.calls).toEqual([[{ linkPreviewDefault: "collapsed" }]])
  })

  it("should atomically enable and save arbitrary positive counts", async () => {
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    await user.clear(countInput())
    await user.type(countInput(), "123{Enter}")
    expect(updatePreferences).toHaveBeenCalledWith({ linkPreviewDefault: "open", linkPreviewOpenCount: 123 })
  })

  it("should reject blank and fractional drafts without saving", async () => {
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    await user.clear(countInput())
    await user.keyboard("{Enter}")
    expect(screen.getByRole("alert")).toBeVisible()
    await user.type(countInput(), "1.5{Enter}")
    expect(screen.getByRole("alert")).toBeVisible()
    expect(updatePreferences).not.toHaveBeenCalled()
  })

  it("puts the saved count back on Escape, and saves a typed one when the page closes", async () => {
    const user = userEvent.setup()
    const { unmount } = render(<LinkPreviewSettings />)
    await user.clear(countInput())
    await user.type(countInput(), "9{Escape}")
    const afterEscape = { value: countInput().getAttribute("value"), writes: [...updatePreferences.mock.calls] }
    await user.clear(countInput())
    await user.type(countInput(), "8")
    unmount()

    expect({ afterEscape, writes: updatePreferences.mock.calls }).toEqual({
      afterEscape: { value: "3", writes: [] },
      writes: [[{ linkPreviewDefault: "open", linkPreviewOpenCount: 8 }]],
    })
  })

  it("should save expand all atomically", async () => {
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    await choose(user, "Previews to expand", "All")
    expect(updatePreferences).toHaveBeenCalledWith({ linkPreviewDefault: "open", linkPreviewOpenCount: "all" })
  })

  it.each([
    ["Previews to expand", { linkPreviewDefault: "open", linkPreviewOpenCount: DEFAULT_LINK_PREVIEW_OPEN_COUNT }],
    ["Images previews", { linkPreviewTypeOverrides: { image: DEFAULT_LINK_PREVIEW_OPEN_COUNT } }],
  ])("should start %s at a positive count when choosing the first…", async (group, expected) => {
    mockPreferences("all")
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    await choose(user, group, "First")
    expect(updatePreferences).toHaveBeenCalledWith(expected)
  })

  it("should restore the last positive draft when leaving all", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<LinkPreviewSettings />)
    await user.clear(countInput())
    await user.type(countInput(), "7{Enter}")
    await choose(user, "Previews to expand", "All")

    mockPreferences("all")
    rerender(<LinkPreviewSettings />)
    updatePreferences.mockClear()

    await choose(user, "Previews to expand", "First")
    expect(updatePreferences).toHaveBeenCalledWith({ linkPreviewDefault: "open", linkPreviewOpenCount: 7 })
  })

  it("should remove a type override when same as default is selected", async () => {
    mockPreferences(3, { image: 0, website: 12 })
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    await choose(user, "Images previews", "Default")
    expect(updatePreferences).toHaveBeenCalledWith({ linkPreviewTypeOverrides: { website: 12 } })
  })

  it("keeps per-type counts closed behind a summary of what differs", async () => {
    mockPreferences(3, { image: 0, github: "all" })
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)

    const disclosure = screen.getByRole("button", { name: /By link type/ })
    const closed = {
      expanded: disclosure.getAttribute("aria-expanded"),
      summary: disclosure.textContent,
      typeControls: screen.queryByRole("combobox", { name: "Images previews" }),
    }
    await user.click(disclosure)

    expect({ closed, opened: screen.getByRole("combobox", { name: "Images previews" }) !== null }).toEqual({
      closed: { expanded: "false", summary: "By link typeOwn count for Images, GitHub", typeControls: null },
      opened: true,
    })
  })

  it("opens the per-type counts when a link lands on them", () => {
    render(
      <MemoryRouter initialEntries={["/?settings=messages&setting=link-preview-types"]}>
        <SettingsProvider>
          <LinkPreviewSettings />
        </SettingsProvider>
      </MemoryRouter>
    )

    expect(screen.getByRole("combobox", { name: "Images previews" })).toBeVisible()
  })
})
