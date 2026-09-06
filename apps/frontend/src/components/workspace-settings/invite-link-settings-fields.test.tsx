import { describe, expect, it, vi } from "vitest"
import { render, screen, userEvent } from "@/test"
import {
  InviteLinkSettingsFields,
  localDateTimeToIso,
  validateInviteLinkSettings,
  type InviteLinkSettingsValue,
} from "./invite-link-settings-fields"

const valid: InviteLinkSettingsValue = {
  unlimited: false,
  maxUses: "2",
  neverExpires: false,
  expiresAt: "2099-01-01T12:00",
}

describe("invite link settings", () => {
  it("should reject invalid limits and past expiration", () => {
    expect(validateInviteLinkSettings({ ...valid, maxUses: "0" })).toBe(
      "Maximum joins must be a positive whole number."
    )
    expect(validateInviteLinkSettings({ ...valid, expiresAt: "2020-01-01T12:00" })).toBe(
      "Expiration must be in the future."
    )
    expect(validateInviteLinkSettings({ ...valid, maxUses: "1" }, 2)).toBe("Maximum joins cannot be lower than 2.")
  })

  it("should accept unlimited joins and no expiration", () => {
    expect(
      validateInviteLinkSettings({ ...valid, unlimited: true, neverExpires: true, maxUses: "", expiresAt: "" })
    ).toBeNull()
  })

  it("should expose unlimited and never-expiring controls", async () => {
    const onChange = vi.fn()
    render(<InviteLinkSettingsFields value={valid} onChange={onChange} />)

    await userEvent.click(screen.getByRole("switch", { name: "Unlimited" }))
    await userEvent.click(screen.getByRole("switch", { name: "Never expires" }))

    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      { ...valid, unlimited: true },
      { ...valid, neverExpires: true },
    ])
    expect(localDateTimeToIso("2099-01-01T12:00")).toMatch(/^2099-01-01T/)
  })
})
