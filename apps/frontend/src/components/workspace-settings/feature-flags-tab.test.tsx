import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import * as flagsModule from "@/hooks/use-feature-flags"
import { FeatureFlagsTab } from "./feature-flags-tab"

afterEach(() => vi.restoreAllMocks())

describe("FeatureFlagsTab", () => {
  it("names each flag in words with a plain state and who it's rolling out to", () => {
    vi.spyOn(flagsModule, "useOverriddenFeatureFlags").mockReturnValue([
      { key: "searchQueryLog", value: "on", defaultValue: "off", scope: "user" },
      { key: "batchedLiveWrites", value: "off", defaultValue: "on", scope: "workspace" },
    ])
    render(<FeatureFlagsTab workspaceId="ws_1" />)

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Search loggingKeeps your searches and what you opened, to improve search.Rolling out to you · normally offOn",
      "Batched background updatesSaves updates from streams you're not viewing together.Rolling out to this workspace · normally onOff",
    ])
  })
})
