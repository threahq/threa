import { describe, it, expect, vi, beforeEach } from "vitest"
import { render } from "@testing-library/react"
import * as contextsModule from "@/contexts"
import * as accountScopeModule from "@/auth/account-scope"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as workspaceUserModule from "@/hooks/use-current-workspace-user-id"
import * as posthogModule from "./posthog"
import * as diagnosticsModule from "@/lib/connectivity-diagnostics"
import { AnalyticsConsentGate } from "./gate"

type Consent = "unset" | "granted" | "denied"
const analytics = { posthogToken: "tok_1", posthogHost: "https://eu.example.com" }

function mockInputs(params: {
  consent: Consent
  analytics: typeof analytics | null
  userId: string | null
  replay?: boolean
  diagnostics?: boolean
  accountId?: string | null
  preferencesPending?: boolean
}) {
  vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
    preferences: {
      analyticsConsent: params.consent,
      sessionReplayOptIn: params.replay ?? false,
      performanceDiagnosticsOptIn: params.diagnostics ?? false,
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    isLoading: params.preferencesPending ?? false,
  } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
  vi.spyOn(useWorkspacesModule, "useWorkspaceBootstrap").mockReturnValue({
    data: { analytics: params.analytics, featureFlags: { user: { perfDiagnostics: "available" } } },
  } as unknown as ReturnType<typeof useWorkspacesModule.useWorkspaceBootstrap>)
  vi.spyOn(workspaceUserModule, "useCurrentWorkspaceUserId").mockReturnValue(params.userId)
  vi.spyOn(accountScopeModule, "useAccountScopeOptional").mockReturnValue(
    params.accountId === null
      ? null
      : ({ activeWorkosUserId: params.accountId ?? "workos_1" } as ReturnType<
          typeof accountScopeModule.useAccountScopeOptional
        >)
  )
}

describe("AnalyticsConsentGate", () => {
  let start: ReturnType<typeof vi.spyOn>
  let stop: ReturnType<typeof vi.spyOn>
  let replay: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.restoreAllMocks()
    start = vi.spyOn(posthogModule, "startAnalytics").mockImplementation(() => Promise.resolve())
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

  it("should leave the recorder off until replay is opted into as well", async () => {
    mockInputs({ consent: "granted", analytics, userId: "usr_1" })
    const { rerender } = render(<AnalyticsConsentGate workspaceId="ws_1" />)
    await vi.waitFor(() => expect(replay).toHaveBeenCalledWith(false))

    mockInputs({ consent: "granted", analytics, userId: "usr_1", replay: true })
    rerender(<AnalyticsConsentGate workspaceId="ws_1" />)

    await vi.waitFor(() => expect(replay).toHaveBeenLastCalledWith(true))
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

  it("should configure diagnostics only with analytics consent, feature access, and opt-in", () => {
    const authorize = vi.spyOn(diagnosticsModule, "authorizeConnectivityDiagnostics").mockImplementation(() => {})
    mockInputs({ consent: "granted", analytics, userId: "usr_1", diagnostics: true })

    render(<AnalyticsConsentGate workspaceId="ws_1" />)

    expect(authorize).toHaveBeenCalledWith(
      "workos_1",
      {
        token: "tok_1",
        host: "https://eu.example.com",
        userId: "usr_1",
        workspaceId: "ws_1",
        region: "https://eu.example.com",
      },
      "2026-06-01T00:00:00.000Z"
    )
  })

  it("should not treat an optimistic preference update as a new diagnostics grant", () => {
    const authorize = vi.spyOn(diagnosticsModule, "authorizeConnectivityDiagnostics").mockImplementation(() => {})
    mockInputs({
      consent: "granted",
      analytics,
      userId: "usr_1",
      diagnostics: true,
      preferencesPending: true,
    })

    render(<AnalyticsConsentGate workspaceId="ws_1" />)

    expect(authorize).not.toHaveBeenCalled()
  })

  it("should revoke the old scope when diagnostics consent is withdrawn", () => {
    const revoke = vi.spyOn(diagnosticsModule, "revokeConnectivityDiagnostics").mockImplementation(() => {})
    mockInputs({ consent: "granted", analytics, userId: "usr_1", diagnostics: true })
    const { rerender } = render(<AnalyticsConsentGate workspaceId="ws_1" />)

    mockInputs({ consent: "granted", analytics, userId: "usr_1", diagnostics: false })
    rerender(<AnalyticsConsentGate workspaceId="ws_1" />)

    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "workos_1", userId: "usr_1", workspaceId: "ws_1" })
    )
  })

  it("should suspend diagnostics but keep analytics running when the gate unmounts", () => {
    const suspend = vi.spyOn(diagnosticsModule, "suspendConnectivityDiagnostics").mockImplementation(() => {})
    mockInputs({ consent: "granted", analytics, userId: "usr_1", diagnostics: true })
    const { unmount } = render(<AnalyticsConsentGate workspaceId="ws_1" />)

    unmount()

    expect(suspend).toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
})
