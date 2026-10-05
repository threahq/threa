import { describe, expect, it } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { memo, startTransition, Suspense, use, useState } from "react"
import { createSelectorContext } from "./selector-context"

const { Provider, useSelector } = createSelectorContext<{ a: number; b: number }>({ a: 0, b: 0 })

const never = new Promise<void>(() => {})

function Suspender({ suspend }: { suspend: boolean }) {
  if (suspend) use(never)
  return null
}

describe("createSelectorContext", () => {
  it("re-renders a memoized consumer only when its selection changes", () => {
    let renders = 0
    const Reader = memo(function Reader() {
      renders++
      return <span data-testid="a">{useSelector((value) => value.a)}</span>
    })
    const { rerender } = render(
      <Provider value={{ a: 1, b: 1 }}>
        <Reader />
      </Provider>
    )
    const mounted = renders

    rerender(
      <Provider value={{ a: 1, b: 2 }}>
        <Reader />
      </Provider>
    )
    expect({ text: screen.getByTestId("a").textContent, renders }).toEqual({ text: "1", renders: mounted })

    rerender(
      <Provider value={{ a: 2, b: 2 }}>
        <Reader />
      </Provider>
    )
    expect(screen.getByTestId("a").textContent).toBe("2")
  })

  it("shows the new value to a consumer mounting in the pass that changes it", () => {
    function Reader() {
      return <span data-testid="late">{useSelector((value) => value.a)}</span>
    }
    const { rerender } = render(<Provider value={{ a: 1, b: 1 }}>{null}</Provider>)
    rerender(
      <Provider value={{ a: 2, b: 1 }}>
        <Reader />
      </Provider>
    )
    expect(screen.getByTestId("late").textContent).toBe("2")
  })

  it("keeps an uncommitted transition's value away from consumers on screen", async () => {
    let bump = () => {}
    let startSwitch = () => {}
    const Reader = memo(function Reader() {
      const [, setCount] = useState(0)
      bump = () => setCount((count) => count + 1)
      return <span data-testid="a">{useSelector((value) => value.a)}</span>
    })
    function App() {
      const [a, setA] = useState(1)
      const [suspend, setSuspend] = useState(false)
      startSwitch = () =>
        startTransition(() => {
          setA(2)
          setSuspend(true)
        })
      return (
        <Suspense fallback={null}>
          <Provider value={{ a, b: 0 }}>
            <Reader />
            <Suspender suspend={suspend} />
          </Provider>
        </Suspense>
      )
    }
    render(<App />)

    await act(async () => startSwitch())
    await act(async () => bump())

    expect(screen.getByTestId("a").textContent).toBe("1")
  })
})
