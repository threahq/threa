import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MicButton, formatClock, recordingRingShadow } from "./mic-button"

describe("formatClock", () => {
  it("renders m:ss with zero-padded seconds", () => {
    expect(formatClock(0)).toBe("0:00")
    expect(formatClock(5_000)).toBe("0:05")
    expect(formatClock(65_000)).toBe("1:05")
    expect(formatClock(600_000)).toBe("10:00")
  })

  it("floors sub-second remainders and clamps negatives to 0:00", () => {
    expect(formatClock(1_999)).toBe("0:01")
    expect(formatClock(-500)).toBe("0:00")
  })
})

describe("recordingRingShadow", () => {
  it("layers a crisp inner ring and a soft outer ring", () => {
    const shadow = recordingRingShadow(0)
    expect(shadow.split(", ")).toEqual([
      "0 0 0 1.00px hsl(var(--destructive) / 0.300)",
      "0 0 0 2.50px hsl(var(--destructive) / 0.080)",
    ])
  })

  it("grows spread and opacity with the input level", () => {
    expect(recordingRingShadow(1).split(", ")).toEqual([
      "0 0 0 2.00px hsl(var(--destructive) / 0.550)",
      "0 0 0 6.50px hsl(var(--destructive) / 0.180)",
    ])
  })

  it("clamps out-of-range levels", () => {
    expect(recordingRingShadow(-1)).toBe(recordingRingShadow(0))
    expect(recordingRingShadow(5)).toBe(recordingRingShadow(1))
  })
})

// jsdom provides neither AudioWorkletNode nor navigator.mediaDevices.getUserMedia,
// so the capability check fails closed — exactly the unsupported-browser path we
// want the button to handle gracefully (disabled, not crashing).
describe("MicButton", () => {
  it("renders disabled when the browser can't capture audio", () => {
    render(
      <TooltipProvider>
        <MicButton workspaceId="ws_1" onInsertText={vi.fn()} />
      </TooltipProvider>
    )

    const button = screen.getByRole("button", { name: "Dictate a message" })
    expect(button).toBeDisabled()
  })

  it("stays disabled even when the composer enables its controls", () => {
    render(
      <TooltipProvider>
        <MicButton workspaceId="ws_1" onInsertText={vi.fn()} disabled={false} />
      </TooltipProvider>
    )

    expect(screen.getByRole("button", { name: "Dictate a message" })).toBeDisabled()
  })
})
