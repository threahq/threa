import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render } from "@testing-library/react"
import * as contextsModule from "@/contexts"
import { NO_CAPTURE, getPerfCapture, isUploadPermitted, resetPerfArming, setPerfConsentArmed } from "./capture"
import { setStorageAccount } from "@/lib/account-storage"
import { PerfCaptureProvider } from "./context"
import { PerfCaptureConsentGate } from "./consent"

const CONSENT_WORKSPACE_KEY = "threa:acct:acct_1:perf:consentWorkspace"

function mockConsent(optIn: boolean | null) {
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

  it("arms when the preference is on", () => {
    mockConsent(true)
    renderGate()

    expect(getPerfCapture()).not.toBe(NO_CAPTURE)
    expect(isUploadPermitted()).toBe(true)
  })

  it("never arms while the preference is off", () => {
    mockConsent(false)
    renderGate()

    expect(getPerfCapture()).toBe(NO_CAPTURE)
    expect(isUploadPermitted()).toBe(false)
  })

  it("re-arms and disarms on a preference change without a remount", () => {
    mockConsent(false)
    const { rerender } = renderGate()
    expect(getPerfCapture()).toBe(NO_CAPTURE)

    mockConsent(true)
    rerender(
      <PerfCaptureProvider>
        <PerfCaptureConsentGate workspaceId="ws_1" />
      </PerfCaptureProvider>
    )
    const armed = getPerfCapture()
    expect(armed).not.toBe(NO_CAPTURE)

    mockConsent(false)
    rerender(
      <PerfCaptureProvider>
        <PerfCaptureConsentGate workspaceId="ws_1" />
      </PerfCaptureProvider>
    )
    expect(getPerfCapture()).toBe(NO_CAPTURE)
  })

  it("keeps a capture armed from remembered consent while preferences are unread, and through its confirmation", () => {
    setPerfConsentArmed(true)
    mockConsent(null)
    const { rerender } = renderGate()
    const armed = getPerfCapture()
    expect(armed).not.toBe(NO_CAPTURE)
    armed.mark("bootstrap.wsJoin", 4200)

    mockConsent(true)
    rerender(gate())

    expect(getPerfCapture()).toBe(armed)
    expect(armed.snapshot()).toEqual([expect.objectContaining({ name: "bootstrap.wsJoin", value: 4200 })])
    expect(window.localStorage.getItem(CONSENT_WORKSPACE_KEY)).toBe("ws_1")
  })

  it("disarms remembered consent and forgets it once the preference reads as withdrawn", () => {
    window.localStorage.setItem(CONSENT_WORKSPACE_KEY, "ws_1")
    setPerfConsentArmed(true)
    mockConsent(false)
    renderGate()

    expect(getPerfCapture()).toBe(NO_CAPTURE)
    expect(window.localStorage.getItem(CONSENT_WORKSPACE_KEY)).toBeNull()
  })

  it("arms at mount from the account's remembered consent only on that workspace's pages", () => {
    window.localStorage.setItem(CONSENT_WORKSPACE_KEY, "ws_1")
    mockConsent(null)

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
