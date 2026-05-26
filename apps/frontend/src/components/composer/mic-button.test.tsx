import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import * as voiceDictation from "@/hooks/use-voice-dictation"
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

// Drive the dictation states the real hook can't reach in jsdom (no audio /
// socket) by spying the hook, so we can assert the button's state-dependent
// chrome — the recording timer and the inline error/resume surface.
describe("MicButton state surfaces", () => {
  afterEach(() => vi.restoreAllMocks())

  function mockDictation(overrides: Partial<ReturnType<typeof voiceDictation.useVoiceDictation>>) {
    vi.spyOn(voiceDictation, "useVoiceDictation").mockReturnValue({
      state: "idle",
      supported: true,
      unsupportedReason: null,
      error: null,
      interimText: "",
      level: 0,
      elapsedMs: 0,
      maxDurationMs: null,
      chunks: new Map(),
      hasUnlockedChunks: false,
      showOriginal: false,
      setShowOriginal: vi.fn(),
      noAudioWarning: null,
      start: vi.fn(),
      stop: vi.fn(),
      ...overrides,
    })
  }

  function renderButton() {
    render(
      <TooltipProvider>
        <MicButton workspaceId="ws_1" onInsertText={vi.fn()} />
      </TooltipProvider>
    )
  }

  it("surfaces the error inline (not just a hover tooltip) with a retry affordance", () => {
    mockDictation({ state: "error", error: "Dictation connection lost" })
    renderButton()

    // The inline status is what a touch user (no hover) sees.
    expect(screen.getByRole("status")).toHaveTextContent("Dictation connection lost")
    // The button itself is the tap-to-resume target.
    expect(screen.getByRole("button", { name: "Retry dictation" })).toBeEnabled()
  })

  it("shows a live elapsed clock while recording", () => {
    mockDictation({ state: "recording", elapsedMs: 5_000, maxDurationMs: 600_000 })
    renderButton()

    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeEnabled()
    expect(screen.getByText("0:05")).toBeInTheDocument()
  })

  it("hides the polish toggle when there are no polished chunks to swap", () => {
    mockDictation({ state: "recording", hasUnlockedChunks: false })
    renderButton()

    expect(screen.queryByRole("button", { name: /Switch to/i })).not.toBeInTheDocument()
  })

  it("offers a polish toggle once a chunk lands and reads as 'Showing polished' by default", () => {
    mockDictation({ state: "recording", hasUnlockedChunks: true, showOriginal: false })
    renderButton()

    const toggle = screen.getByRole("button", { name: "Switch to original transcript" })
    expect(toggle).toHaveTextContent("Showing polished")
  })

  it("flips to original when the toggle is clicked", async () => {
    const setShowOriginal = vi.fn()
    mockDictation({ state: "recording", hasUnlockedChunks: true, showOriginal: false, setShowOriginal })
    const user = userEvent.setup()
    renderButton()

    await user.click(screen.getByRole("button", { name: "Switch to original transcript" }))
    expect(setShowOriginal).toHaveBeenCalledWith(true)
  })

  it("keeps the toggle visible after stopping so the user can still flip what landed", () => {
    mockDictation({ state: "idle", hasUnlockedChunks: true, showOriginal: true })
    renderButton()

    expect(screen.getByRole("button", { name: "Switch to polished transcript" })).toHaveTextContent("Showing original")
  })
})
