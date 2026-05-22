import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MicButton, formatClock } from "./mic-button"

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
