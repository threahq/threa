import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import * as flagsModule from "@/hooks/use-feature-flags"
import { FeatureFlagsTab } from "./feature-flags-tab"

afterEach(() => vi.restoreAllMocks())

describe("FeatureFlagsTab", () => {
  it("names each flag in words with a plain state and who it's rolling out to", () => {
    vi.spyOn(flagsModule, "useOverriddenFeatureFlags").mockReturnValue([
      { key: "perfDiagnostics", value: "available", defaultValue: "off", scope: "user" },
      { key: "calls", value: "off", defaultValue: "on", scope: "workspace" },
    ])
    render(<FeatureFlagsTab workspaceId="ws_1" />)

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Performance diagnosticsAdds Performance diagnostics to Privacy & security.Rolling out to you · normally offAvailable",
      "CallsVoice and video calls in streams.Rolling out to this workspace · normally onOff",
    ])
  })
})
