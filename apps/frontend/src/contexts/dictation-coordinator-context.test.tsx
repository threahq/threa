import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"
import { useEffect } from "react"
import { DictationCoordinatorProvider, useDictationCoordinator } from "./dictation-coordinator-context"

function Activator({
  stop,
  onReady,
}: {
  stop: () => void
  onReady: (activate: () => void, deactivate: () => void) => void
}) {
  const coordinator = useDictationCoordinator()
  useEffect(() => {
    onReady(
      () => coordinator.activate(stop),
      () => coordinator.deactivate(stop)
    )
  }, [coordinator, stop, onReady])
  return null
}

describe("DictationCoordinatorProvider", () => {
  it("stops the previously-active take when a new take activates", () => {
    const stopA = vi.fn()
    const stopB = vi.fn()
    let activateA = () => {}
    let activateB = () => {}

    render(
      <DictationCoordinatorProvider>
        <Activator stop={stopA} onReady={(a) => (activateA = a)} />
        <Activator stop={stopB} onReady={(a) => (activateB = a)} />
      </DictationCoordinatorProvider>
    )

    activateA()
    expect(stopA).not.toHaveBeenCalled()

    activateB()
    expect(stopA).toHaveBeenCalledTimes(1)
    expect(stopB).not.toHaveBeenCalled()
  })

  it("does not stop a take that re-activates itself", () => {
    const stopA = vi.fn()
    let activateA = () => {}

    render(
      <DictationCoordinatorProvider>
        <Activator stop={stopA} onReady={(a) => (activateA = a)} />
      </DictationCoordinatorProvider>
    )

    activateA()
    activateA()
    expect(stopA).not.toHaveBeenCalled()
  })

  it("releases the slot only when the deactivating identity still holds it", () => {
    const stopA = vi.fn()
    const stopB = vi.fn()
    let activateA = () => {}
    let deactivateA = () => {}
    let activateB = () => {}

    render(
      <DictationCoordinatorProvider>
        <Activator
          stop={stopA}
          onReady={(a, d) => {
            activateA = a
            deactivateA = d
          }}
        />
        <Activator stop={stopB} onReady={(a) => (activateB = a)} />
      </DictationCoordinatorProvider>
    )

    // A activates, then B takes over (stopping A). A's late deactivate must not
    // release B's slot.
    activateA()
    activateB()
    expect(stopA).toHaveBeenCalledTimes(1)

    deactivateA()
    // A new activation should still stop B, proving B kept the slot.
    activateA()
    expect(stopB).toHaveBeenCalledTimes(1)
  })

  it("activation is inert without a provider mounted", () => {
    const stop = vi.fn()
    let activate = () => {}

    render(<Activator stop={stop} onReady={(a) => (activate = a)} />)

    activate()
    expect(stop).not.toHaveBeenCalled()
  })
})
