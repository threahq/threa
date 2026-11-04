import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render } from "@testing-library/react"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import { NO_CAPTURE, getPerfCapture, isUploadPermitted, resetPerfArming, setPerfConsentArmed } from "./capture"
import { setStorageAccount } from "@/lib/account-storage"
import { PerfCaptureProvider } from "./context"
import { PerfCaptureConsentGate } from "./consent"

const CONSENT_WORKSPACE_KEY = "threa:acct:acct_1:perf:consentWorkspace"

function mockConsent(flag: "off" | "available" | null, optIn: boolean | null) {
  vi.spyOn(hooksModule, "useFeatureFlagWhenKnown").mockReturnValue(flag as never)
  vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
    preferences: optIn === null ? null : { performanceDiagnosticsOptIn: optIn },
  } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
}

function gate() {
  return (
    <PerfCaptureProvider>
      <PerfCaptureConsentGate workspaceId="ws_1" />
    </PerfCaptureProvider>
  )
}

function renderGate() {
  return render(gate())
}

describe("perf capture consent arming", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetPerfArming()
    setStorageAccount("acct_1")
    window.localStorage.removeItem(CONSENT_WORKSPACE_KEY)
  })

  afterEach(() => {
    resetPerfArming()
    window.localStorage.removeItem(CONSENT_WORKSPACE_KEY)
    window.history.replaceState(null, "", "/")
    setStorageAccount(null)
  })

  it("arms only when the flag is available AND the preference is on", () => {
    mockConsent("available", true)
    renderGate()

    expect(getPerfCapture()).not.toBe(NO_CAPTURE)
    expect(isUploadPermitted()).toBe(true)
  })

  it("never arms on the flag alone", () => {
    mockConsent("available", false)
    renderGate()

    expect(getPerfCapture()).toBe(NO_CAPTURE)
    expect(isUploadPermitted()).toBe(false)
  })

  it("never arms on the preference alone", () => {
    mockConsent("off", true)
    renderGate()

    expect(getPerfCapture()).toBe(NO_CAPTURE)
  })

  it("re-arms and disarms on a preference change without a remount", () => {
    mockConsent("available", false)
    const { rerender } = renderGate()
    expect(getPerfCapture()).toBe(NO_CAPTURE)

    mockConsent("available", true)
    rerender(
      <PerfCaptureProvider>
        <PerfCaptureConsentGate workspaceId="ws_1" />
      </PerfCaptureProvider>
    )
    const armed = getPerfCapture()
    expect(armed).not.toBe(NO_CAPTURE)

    mockConsent("available", false)
    rerender(
      <PerfCaptureProvider>
        <PerfCaptureConsentGate workspaceId="ws_1" />
      </PerfCaptureProvider>
    )
    expect(getPerfCapture()).toBe(NO_CAPTURE)
  })

  it("keeps a capture armed from remembered consent while the pair is unread, and through its confirmation", () => {
    setPerfConsentArmed(true)
    mockConsent(null, null)
    const { rerender } = renderGate()
    const armed = getPerfCapture()
    expect(armed).not.toBe(NO_CAPTURE)
    armed.mark("bootstrap.wsJoin", 4200)

    mockConsent("available", true)
    rerender(gate())

    expect(getPerfCapture()).toBe(armed)
    expect(armed.snapshot()).toEqual([expect.objectContaining({ name: "bootstrap.wsJoin", value: 4200 })])
    expect(window.localStorage.getItem(CONSENT_WORKSPACE_KEY)).toBe("ws_1")
  })

  it("disarms remembered consent and forgets it once the pair reads as withdrawn", () => {
    window.localStorage.setItem(CONSENT_WORKSPACE_KEY, "ws_1")
    setPerfConsentArmed(true)
    mockConsent("available", false)
    renderGate()

    expect(getPerfCapture()).toBe(NO_CAPTURE)
    expect(window.localStorage.getItem(CONSENT_WORKSPACE_KEY)).toBeNull()
  })

  it("arms at mount from the account's remembered consent only on that workspace's pages", () => {
    window.localStorage.setItem(CONSENT_WORKSPACE_KEY, "ws_1")
    mockConsent(null, null)

    window.history.replaceState(null, "", "/w/ws_10/s/stream_1")
    renderGate().unmount()
    expect(getPerfCapture()).toBe(NO_CAPTURE)

    setStorageAccount("acct_2")
    window.history.replaceState(null, "", "/w/ws_1/s/stream_1")
    renderGate().unmount()
    expect(getPerfCapture()).toBe(NO_CAPTURE)

    setStorageAccount("acct_1")
    renderGate()
    expect(getPerfCapture()).not.toBe(NO_CAPTURE)
  })
})
