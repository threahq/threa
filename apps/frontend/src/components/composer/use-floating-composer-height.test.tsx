import { describe, it, expect, afterEach, vi } from "vitest"
import { render } from "@testing-library/react"
import { FLOATING_COMPOSER_HEIGHT_VAR } from "./floating-composer-anchor"
import { useFloatingComposerHeight } from "./use-floating-composer-height"

type ResizeCallback = () => void

const observers: ResizeCallback[] = []
class ManualResizeObserver {
  constructor(cb: ResizeCallback) {
    observers.push(cb)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ManualResizeObserver as unknown as typeof ResizeObserver

afterEach(() => {
  observers.length = 0
  vi.restoreAllMocks()
})

/** A shell whose measured height is driven by the test. */
function Shell({
  anchorEl,
  ownerId,
  height,
  active = true,
  onHeightChange,
}: {
  anchorEl: HTMLElement
  ownerId: string
  height: { current: number }
  active?: boolean
  onHeightChange?: (px: number, opts: { initial: boolean }) => void
}) {
  const ref = useFloatingComposerHeight({ anchorEl, ownerId, active, onHeightChange })
  return (
    <div
      ref={(node) => {
        if (node) node.getBoundingClientRect = () => ({ height: height.current }) as DOMRect
        ref.current = node
      }}
    />
  )
}

function makeAnchor() {
  const el = document.createElement("div")
  document.body.appendChild(el)
  return el
}

describe("useFloatingComposerHeight", () => {
  it("publishes a non-zero height and tags the anchor with its owner id", () => {
    const anchor = makeAnchor()
    render(<Shell anchorEl={anchor} ownerId="owner-a" height={{ current: 84 }} />)

    expect({
      height: anchor.style.getPropertyValue(FLOATING_COMPOSER_HEIGHT_VAR),
      owner: anchor.dataset.floatingComposerOwner,
    }).toEqual({ height: "84px", owner: "owner-a" })
  })

  it("cleanup leaves a newer owner's height in place", () => {
    const anchor = makeAnchor()
    const a = render(<Shell anchorEl={anchor} ownerId="owner-a" height={{ current: 84 }} />)
    render(<Shell anchorEl={anchor} ownerId="owner-b" height={{ current: 140 }} />)
    a.unmount()

    expect({
      height: anchor.style.getPropertyValue(FLOATING_COMPOSER_HEIGHT_VAR),
      owner: anchor.dataset.floatingComposerOwner,
    }).toEqual({ height: "140px", owner: "owner-b" })
  })

  it("never publishes a zero height", () => {
    const anchor = makeAnchor()
    const height = { current: 84 }
    render(<Shell anchorEl={anchor} ownerId="owner-a" height={height} />)

    height.current = 0
    for (const trigger of observers) trigger()

    expect(anchor.style.getPropertyValue(FLOATING_COMPOSER_HEIGHT_VAR)).toBe("84px")
  })

  it("fires onHeightChange with initial:true exactly once, before any resize tick", () => {
    const anchor = makeAnchor()
    const height = { current: 84 }
    const onHeightChange = vi.fn()
    render(<Shell anchorEl={anchor} ownerId="owner-a" height={height} onHeightChange={onHeightChange} />)

    expect(onHeightChange.mock.calls).toEqual([[84, { initial: true }]])

    // A resize tick at the same height is not a change; a real growth is.
    for (const trigger of observers) trigger()
    height.current = 120
    for (const trigger of observers) trigger()

    expect(onHeightChange.mock.calls).toEqual([
      [84, { initial: true }],
      [120, { initial: false }],
    ])
  })

  it("re-activating does not report initial again", () => {
    const anchor = makeAnchor()
    const height = { current: 84 }
    const onHeightChange = vi.fn()
    const view = render(<Shell anchorEl={anchor} ownerId="owner-a" height={height} onHeightChange={onHeightChange} />)

    view.rerender(
      <Shell anchorEl={anchor} ownerId="owner-a" height={height} active={false} onHeightChange={onHeightChange} />
    )
    view.rerender(<Shell anchorEl={anchor} ownerId="owner-a" height={height} onHeightChange={onHeightChange} />)

    expect(onHeightChange.mock.calls.filter(([, opts]) => opts.initial)).toEqual([[84, { initial: true }]])
  })

  it("no-ops entirely while inactive", () => {
    const anchor = makeAnchor()
    const onHeightChange = vi.fn()
    render(
      <Shell
        anchorEl={anchor}
        ownerId="owner-a"
        height={{ current: 84 }}
        active={false}
        onHeightChange={onHeightChange}
      />
    )

    expect({
      height: anchor.style.getPropertyValue(FLOATING_COMPOSER_HEIGHT_VAR),
      owner: anchor.dataset.floatingComposerOwner,
      calls: onHeightChange.mock.calls.length,
    }).toEqual({ height: "", owner: undefined, calls: 0 })
  })
})
