import { describe, it, expect, beforeEach } from "vitest"
import { act } from "@testing-library/react"
import { render } from "@/test"
import { clearCallState, setCallPhase, setCallSpeakingLevel, getCallState } from "@/stores/call-store"
import { useCallPhase, useSpeakingLevelRef } from "./call-store-hooks"

let renderCount = 0

function PhaseConsumer() {
  renderCount++
  const phase = useCallPhase()
  return <span data-testid="phase">{phase}</span>
}

function SpeakingRing() {
  const ref = useSpeakingLevelRef<HTMLDivElement>()
  return <div ref={ref} data-testid="ring" />
}

beforeEach(() => {
  clearCallState()
  renderCount = 0
})

describe("call store selector isolation (60fps guard)", () => {
  it("does not re-render a phase consumer when only the speaking level ticks", () => {
    render(<PhaseConsumer />)
    expect(renderCount).toBe(1)

    // A burst of analyser-frequency level updates: none touch the phase slice.
    act(() => {
      for (let i = 0; i < 30; i++) setCallSpeakingLevel(i / 30)
    })
    expect(renderCount).toBe(1)

    // A real phase change does re-render.
    act(() => setCallPhase("connected"))
    expect(renderCount).toBe(2)
  })

  it("writes the live level into a CSS var on the ring node without React state", () => {
    const { getByTestId } = render(<SpeakingRing />)
    act(() => setCallSpeakingLevel(0.7))
    expect(getByTestId("ring").style.getPropertyValue("--speaking-level")).toBe("0.7")
    expect(getCallState().local.speakingLevel).toBe(0.7)
  })
})
