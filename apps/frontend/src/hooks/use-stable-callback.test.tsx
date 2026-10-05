import { describe, expect, it } from "vitest"
import { act, render } from "@testing-library/react"
import { startTransition, Suspense, use, useState } from "react"
import { useStableCallback } from "./use-stable-callback"

const never = new Promise<void>(() => {})

function Suspender({ suspend }: { suspend: boolean }) {
  if (suspend) use(never)
  return null
}

describe("useStableCallback", () => {
  it("keeps one identity and calls the latest committed callback", () => {
    const seen: Array<() => string> = []
    function Host({ label }: { label: string }) {
      seen.push(useStableCallback(() => label))
      return null
    }
    const { rerender } = render(<Host label="first" />)
    rerender(<Host label="second" />)

    expect({ stable: seen[0] === seen[1], result: seen[0]() }).toEqual({ stable: true, result: "second" })
  })

  it("does not hand out the callback of a transition that has not committed", async () => {
    let call = () => ""
    let startSwitch = () => {}
    function App() {
      const [stream, setStream] = useState("stream_a")
      const [suspend, setSuspend] = useState(false)
      call = useStableCallback(() => stream)
      startSwitch = () =>
        startTransition(() => {
          setStream("stream_b")
          setSuspend(true)
        })
      return (
        <Suspense fallback={null}>
          <Suspender suspend={suspend} />
        </Suspense>
      )
    }
    render(<App />)

    await act(async () => startSwitch())

    expect(call()).toBe("stream_a")
  })
})
