import { describe, it, expect, vi, beforeEach } from "vitest"
import { render } from "@testing-library/react"
import * as contextsModule from "@/contexts"
import * as authModule from "@/auth"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as posthogModule from "./posthog"
import { AnalyticsConsentGate } from "./gate"

type Consent = "unset" | "granted" | "denied"
const analytics = { posthogToken: "tok_1", posthogHost: "https://eu.example.com" }

function mockInputs(params: { consent: Consent; analytics: typeof analytics | null; user: { id: string } | null }) {
  vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
    preferences: { analyticsConsent: params.consent },
  } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
  vi.spyOn(useWorkspacesModule, "useWorkspaceBootstrap").mockReturnValue({
    data: { analytics: params.analytics },
  } as unknown as ReturnType<typeof useWorkspacesModule.useWorkspaceBootstrap>)
  vi.spyOn(authModule, "useUser").mockReturnValue(params.user as unknown as ReturnType<typeof authModule.useUser>)
}

describe("AnalyticsConsentGate", () => {
  let start: ReturnType<typeof vi.spyOn>
  let stop: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.restoreAllMocks()
    start = vi.spyOn(posthogModule, "startAnalytics").mockImplementation(() => {})
    stop = vi.spyOn(posthogModule, "stopAnalytics").mockImplementation(() => {})
  })

  it("should start with the workspace target when consent is granted", () => {
    mockInputs({ consent: "granted", analytics, user: { id: "usr_1" } })

    render(<AnalyticsConsentGate workspaceId="ws_1" />)

    expect(start).toHaveBeenCalledWith({
      token: "tok_1",
      host: "https://eu.example.com",
      distinctId: "usr_1",
      workspaceId: "ws_1",
    })
    expect(stop).not.toHaveBeenCalled()
  })

  it.each<[string, Consent, typeof analytics | null, { id: string } | null]>([
    ["consent is unset", "unset", analytics, { id: "usr_1" }],
    ["consent is denied", "denied", analytics, { id: "usr_1" }],
    ["the workspace has no analytics config", "granted", null, { id: "usr_1" }],
    ["there is no user", "granted", analytics, null],
  ])("should stop and never start when %s", (_label, consent, analyticsConfig, user) => {
    mockInputs({ consent, analytics: analyticsConfig, user })

    render(<AnalyticsConsentGate workspaceId="ws_1" />)

    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })

  it("should stop when consent flips to denied without a remount", () => {
    mockInputs({ consent: "granted", analytics, user: { id: "usr_1" } })
    const { rerender } = render(<AnalyticsConsentGate workspaceId="ws_1" />)
    expect(start).toHaveBeenCalledTimes(1)

    mockInputs({ consent: "denied", analytics, user: { id: "usr_1" } })
    rerender(<AnalyticsConsentGate workspaceId="ws_1" />)

    expect(stop).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("should keep analytics running when the gate unmounts", () => {
    mockInputs({ consent: "granted", analytics, user: { id: "usr_1" } })
    const { unmount } = render(<AnalyticsConsentGate workspaceId="ws_1" />)

    unmount()

    expect(stop).not.toHaveBeenCalled()
  })
})
