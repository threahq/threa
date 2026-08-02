import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render } from "@testing-library/react"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import { NO_CAPTURE, getPerfCapture, isUploadPermitted, resetPerfArming } from "./capture"
import { PerfCaptureProvider } from "./context"
import { PerfCaptureConsentGate } from "./consent"

function mockConsent(flag: "off" | "available", optIn: boolean) {
  vi.spyOn(hooksModule, "useFeatureFlag").mockReturnValue(flag as never)
  vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
    preferences: { performanceDiagnosticsOptIn: optIn },
  } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
}

function renderGate() {
  return render(
    <PerfCaptureProvider>
      <PerfCaptureConsentGate workspaceId="ws_1" />
    </PerfCaptureProvider>
  )
}

describe("perf capture consent arming", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetPerfArming()
  })

  afterEach(() => {
    resetPerfArming()
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
})
