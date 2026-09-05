import { describe, it, expect, vi, beforeEach } from "vitest"
import { render } from "@testing-library/react"
import * as contextsModule from "@/contexts"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as workspaceUserModule from "@/hooks/use-current-workspace-user-id"
import * as posthogModule from "./posthog"
import { AnalyticsConsentGate } from "./gate"

type Consent = "unset" | "granted" | "denied"
const analytics = { posthogToken: "tok_1", posthogHost: "https://eu.example.com" }

function mockInputs(params: {
  consent: Consent
  analytics: typeof analytics | null
  userId: string | null
  replay?: boolean
}) {
  vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
    preferences: { analyticsConsent: params.consent, sessionReplayOptIn: params.replay ?? false },
  } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
  vi.spyOn(useWorkspacesModule, "useWorkspaceBootstrap").mockReturnValue({
    data: { analytics: params.analytics },
  } as unknown as ReturnType<typeof useWorkspacesModule.useWorkspaceBootstrap>)
  vi.spyOn(workspaceUserModule, "useCurrentWorkspaceUserId").mockReturnValue(params.userId)
}

describe("AnalyticsConsentGate", () => {
  let start: ReturnType<typeof vi.spyOn>
  let stop: ReturnType<typeof vi.spyOn>
  let replay: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.restoreAllMocks()
    start = vi.spyOn(posthogModule, "startAnalytics").mockImplementation(() => {})
    stop = vi.spyOn(posthogModule, "stopAnalytics").mockImplementation(() => {})
    replay = vi.spyOn(posthogModule, "setSessionReplay").mockImplementation(() => {})
  })

  it("should start with the workspace-scoped user id when consent is granted", () => {
    mockInputs({ consent: "granted", analytics, userId: "usr_1" })

    render(<AnalyticsConsentGate workspaceId="ws_1" />)

    expect(start).toHaveBeenCalledWith({
      token: "tok_1",
      host: "https://eu.example.com",
      distinctId: "usr_1",
      workspaceId: "ws_1",
    })
    expect(stop).not.toHaveBeenCalled()
  })

  it.each<[string, Consent, typeof analytics | null, string | null]>([
    ["consent is unset", "unset", analytics, "usr_1"],
    ["consent is denied", "denied", analytics, "usr_1"],
    ["the workspace has no analytics config", "granted", null, "usr_1"],
    ["the workspace user is not loaded yet", "granted", analytics, null],
  ])("should stop and never start when %s", (_label, consent, analyticsConfig, userId) => {
    mockInputs({ consent, analytics: analyticsConfig, userId })

    render(<AnalyticsConsentGate workspaceId="ws_1" />)

    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })

  it("should leave the recorder off until replay is opted into as well", () => {
    mockInputs({ consent: "granted", analytics, userId: "usr_1" })
    const { rerender } = render(<AnalyticsConsentGate workspaceId="ws_1" />)
    expect(replay).toHaveBeenCalledWith(false)

    mockInputs({ consent: "granted", analytics, userId: "usr_1", replay: true })
    rerender(<AnalyticsConsentGate workspaceId="ws_1" />)

    expect(replay).toHaveBeenLastCalledWith(true)
  })

  it("should stop when consent flips to denied without a remount", () => {
    mockInputs({ consent: "granted", analytics, userId: "usr_1" })
    const { rerender } = render(<AnalyticsConsentGate workspaceId="ws_1" />)
    expect(start).toHaveBeenCalledTimes(1)

    mockInputs({ consent: "denied", analytics, userId: "usr_1" })
    rerender(<AnalyticsConsentGate workspaceId="ws_1" />)

    expect(stop).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("should restart against the new workspace when it changes", () => {
    mockInputs({ consent: "granted", analytics, userId: "usr_1" })
    const { rerender } = render(<AnalyticsConsentGate workspaceId="ws_1" />)

    mockInputs({
      consent: "granted",
      analytics: { posthogToken: "tok_2", posthogHost: "https://us.example.com" },
      userId: "usr_2",
    })
    rerender(<AnalyticsConsentGate workspaceId="ws_2" />)

    expect(start).toHaveBeenNthCalledWith(2, {
      token: "tok_2",
      host: "https://us.example.com",
      distinctId: "usr_2",
      workspaceId: "ws_2",
    })
  })

  it("should keep analytics running when the gate unmounts", () => {
    mockInputs({ consent: "granted", analytics, userId: "usr_1" })
    const { unmount } = render(<AnalyticsConsentGate workspaceId="ws_1" />)

    unmount()

    expect(stop).not.toHaveBeenCalled()
  })
})
