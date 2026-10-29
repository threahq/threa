import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as contexts from "@/contexts"
import { LinkPreviewSettings } from "./link-preview-settings"
const updatePreferences = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  vi.restoreAllMocks()
  updatePreferences.mockClear()
  vi.spyOn(contexts, "usePreferences").mockReturnValue({
    preferences: { linkPreviewDefault: "open", linkPreviewOpenCount: 3, linkPreviewTypeOverrides: {} },
    updatePreferences,
    isLoading: false,
  } as unknown as ReturnType<typeof contexts.usePreferences>)
})
describe("LinkPreviewSettings", () => {
  it("should save a global zero without replacing the last positive count", async () => {
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    const input = screen.getByLabelText("Default count")
    await user.clear(input)
    await user.type(input, "0{Enter}")
    expect(updatePreferences).toHaveBeenCalledWith({ linkPreviewDefault: "collapsed" })
  })
  it("should atomically enable and save arbitrary positive counts", async () => {
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    const input = screen.getByLabelText("Default count")
    await user.clear(input)
    await user.type(input, "123{Enter}")
    expect(updatePreferences).toHaveBeenCalledWith({ linkPreviewDefault: "open", linkPreviewOpenCount: 123 })
  })
  it("should reject blank and fractional drafts without saving", async () => {
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    const input = screen.getByLabelText("Default count")
    await user.clear(input)
    await user.keyboard("{Enter}")
    expect(screen.getByRole("alert")).toBeVisible()
    await user.type(input, "1.5{Enter}")
    expect(updatePreferences).not.toHaveBeenCalled()
  })
  it("should save expand all atomically", async () => {
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    await user.click(screen.getByRole("combobox", { name: "Default expansion" }))
    await user.click(screen.getByRole("option", { name: "Expand all" }))
    expect(updatePreferences).toHaveBeenCalledWith({ linkPreviewDefault: "open", linkPreviewOpenCount: "all" })
  })
  it("should remove a type override when use default is selected", async () => {
    vi.spyOn(contexts, "usePreferences").mockReturnValue({
      preferences: {
        linkPreviewDefault: "open",
        linkPreviewOpenCount: 3,
        linkPreviewTypeOverrides: { image: 0, website: 12 },
      },
      updatePreferences,
      isLoading: false,
    } as unknown as ReturnType<typeof contexts.usePreferences>)
    const user = userEvent.setup()
    render(<LinkPreviewSettings />)
    await user.click(screen.getByRole("combobox", { name: "Images expansion" }))
    await user.click(screen.getByRole("option", { name: "Use default" }))
    expect(updatePreferences).toHaveBeenCalledWith({ linkPreviewTypeOverrides: { website: 12 } })
  })
})
