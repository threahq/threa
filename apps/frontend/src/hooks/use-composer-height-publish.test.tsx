import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { type CSSProperties } from "react"
import { render } from "@testing-library/react"
import { useComposerHeightPublish } from "./use-composer-height-publish"

type ResizeCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void

function installManualResizeObserver(): {
  fire: (blockSize: number) => void
  observed: Element[]
  restore: () => void
} {
  let lastCallback: ResizeCallback | null = null
  const observed: Element[] = []
  const original = global.ResizeObserver
  class ManualResizeObserver {
    constructor(cb: ResizeCallback) {
      lastCallback = cb
    }
    observe(target: Element) {
      observed.push(target)
    }
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ManualResizeObserver as unknown as typeof ResizeObserver
  return {
    fire: (blockSize: number) =>
      lastCallback?.(
        [{ borderBoxSize: [{ blockSize, inlineSize: 0 }] }] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver
      ),
    observed,
    restore: () => {
      global.ResizeObserver = original
    },
  }
}

// The hook seeds its baseline from getBoundingClientRect on mount; pin it so
// the initial measure is a known, stable height (jsdom returns 0 otherwise).
function pinInitialHeight(px: number): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { height: px, width: 0, top: 0, left: 0, right: 0, bottom: px, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original
  }
}

function Harness({
  onHeightChange,
  active = true,
  zoneHeight,
  replaceNode = false,
}: {
  onHeightChange: (px: number) => void
  active?: boolean
  /** Pre-existing `--composer-height` on the zone, simulating the first-paint value. */
  zoneHeight?: string
  replaceNode?: boolean
}) {
  const ref = useComposerHeightPublish({ active, onHeightChange })
  const composer = <div ref={ref}>composer</div>
  return (
    <div
      data-editor-zone="main"
      style={zoneHeight ? ({ "--composer-height": zoneHeight } as CSSProperties) : undefined}
    >
      {replaceNode ? <section>{composer}</section> : composer}
    </div>
  )
}

/** Manual ResizeObserver that can fire for one specific observed element. */
function installTargetedResizeObserver(): {
  fireFor: (target: Element, blockSize: number) => void
  restore: () => void
} {
  const original = global.ResizeObserver
  const callbacks = new Map<Element, ResizeCallback>()
  class TargetedResizeObserver {
    constructor(private readonly cb: ResizeCallback) {}
    observe(target: Element) {
      callbacks.set(target, this.cb)
    }
    unobserve(target: Element) {
      callbacks.delete(target)
    }
    disconnect() {
      for (const [target, cb] of callbacks) if (cb === this.cb) callbacks.delete(target)
    }
  }
  global.ResizeObserver = TargetedResizeObserver as unknown as typeof ResizeObserver
  return {
    fireFor: (target, blockSize) =>
      callbacks.get(target)?.(
        [{ borderBoxSize: [{ blockSize, inlineSize: 0 }] }] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver
      ),
    restore: () => {
      global.ResizeObserver = original
    },
  }
}

/** Main timeline + thread panel, the two editor zones that can coexist. */
function TwoZones({ showPanel }: { showPanel: boolean }) {
  const mainRef = useComposerHeightPublish()
  const panelRef = useComposerHeightPublish()
  return (
    <>
      <div data-editor-zone="main">
        <div data-testid="main-composer" ref={mainRef} />
      </div>
      {showPanel && (
        <div data-editor-zone="panel">
          <div data-testid="panel-composer" ref={panelRef} />
        </div>
      )}
    </>
  )
}

function rootHeight(): string {
  return document.documentElement.style.getPropertyValue("--composer-height")
}

describe("useComposerHeightPublish", () => {
  let restoreRect: () => void

  beforeEach(() => {
    restoreRect = pinInitialHeight(80)
    document.documentElement.style.removeProperty("--composer-height")
  })

  afterEach(() => {
    restoreRect()
    document.documentElement.style.removeProperty("--composer-height")
  })

  it("publishes the measured height as --composer-height on the editor zone", () => {
    const ro = installManualResizeObserver()
    try {
      const { container } = render(<Harness onHeightChange={() => {}} />)
      const zone = container.querySelector<HTMLElement>("[data-editor-zone]")!
      expect(zone.style.getPropertyValue("--composer-height")).toBe("80px")

      ro.fire(132)
      expect(zone.style.getPropertyValue("--composer-height")).toBe("132px")
    } finally {
      ro.restore()
    }
  })

  it("does NOT fire onHeightChange for the initial measurement", () => {
    const ro = installManualResizeObserver()
    try {
      const onHeightChange = vi.fn()
      render(<Harness onHeightChange={onHeightChange} />)
      // Mount seeded the baseline at 80px; no change has happened yet.
      expect(onHeightChange).not.toHaveBeenCalled()
    } finally {
      ro.restore()
    }
  })

  it("does NOT fire on the initial measure when it matches the first-paint height", () => {
    const ro = installManualResizeObserver()
    try {
      const onHeightChange = vi.fn()
      // Footer already rendered at 80px (persisted `:root` fallback); the
      // composer measures the same 80px (pinned in beforeEach) — seed silently.
      render(<Harness onHeightChange={onHeightChange} zoneHeight="80px" />)
      expect(onHeightChange).not.toHaveBeenCalled()
    } finally {
      ro.restore()
    }
  })

  it("fires on the initial measure when the persisted footer height was wrong", () => {
    const ro = installManualResizeObserver()
    try {
      const onHeightChange = vi.fn()
      // Footer first painted at 120px (stale persisted value), but the actual
      // composer measures 80px: the spacer will shrink after mount, so the
      // virtualized list must re-anchor (last message would otherwise park too
      // high). The same drift the other direction hides the last message.
      // This fires from a layout effect (pre-paint), flagged `initial: true` so
      // the timeline corrects it synchronously instead of debouncing.
      render(<Harness onHeightChange={onHeightChange} zoneHeight="120px" />)
      expect(onHeightChange).toHaveBeenCalledTimes(1)
      expect(onHeightChange).toHaveBeenLastCalledWith(80, { initial: true })
    } finally {
      ro.restore()
    }
  })

  it("does not overwrite a valid first-paint height with a transient zero measurement", () => {
    restoreRect()
    restoreRect = pinInitialHeight(0)
    const ro = installManualResizeObserver()
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0)
      return 1
    })
    try {
      const onHeightChange = vi.fn()
      const { container } = render(<Harness onHeightChange={onHeightChange} zoneHeight="80px" />)
      const zone = container.querySelector<HTMLElement>("[data-editor-zone]")!

      expect(zone.style.getPropertyValue("--composer-height")).toBe("80px")
      expect(onHeightChange).not.toHaveBeenCalled()

      ro.fire(96)
      expect(zone.style.getPropertyValue("--composer-height")).toBe("96px")
      expect(onHeightChange).toHaveBeenCalledWith(96, { initial: true })
    } finally {
      raf.mockRestore()
      ro.restore()
    }
  })

  it("moves observation when React replaces the ref element without remounting the hook", () => {
    const ro = installManualResizeObserver()
    try {
      const onHeightChange = vi.fn()
      const { container, rerender } = render(<Harness onHeightChange={onHeightChange} />)
      const firstComposer = container.querySelector<HTMLElement>("[data-editor-zone] > div")!
      expect(ro.observed).toEqual([firstComposer])

      rerender(<Harness onHeightChange={onHeightChange} replaceNode />)
      const replacementComposer = container.querySelector<HTMLElement>("[data-editor-zone] section > div")!

      expect(replacementComposer).not.toBe(firstComposer)
      expect(ro.observed).toEqual([firstComposer, replacementComposer])
    } finally {
      ro.restore()
    }
  })

  it("fires onHeightChange only when the height actually changes", () => {
    const ro = installManualResizeObserver()
    try {
      const onHeightChange = vi.fn()
      render(<Harness onHeightChange={onHeightChange} />)

      // Same height as the seeded baseline — no notification.
      ro.fire(80)
      expect(onHeightChange).not.toHaveBeenCalled()

      // Composer grows (e.g. multi-line draft / attachments settle). Runtime
      // changes arrive from the ResizeObserver, flagged `initial: false`.
      ro.fire(160)
      expect(onHeightChange).toHaveBeenCalledTimes(1)
      expect(onHeightChange).toHaveBeenLastCalledWith(160, { initial: false })

      // A redundant fire at the same height must not re-notify.
      ro.fire(160)
      expect(onHeightChange).toHaveBeenCalledTimes(1)

      // Composer shrinks back (message sent, draft cleared).
      ro.fire(80)
      expect(onHeightChange).toHaveBeenCalledTimes(2)
      expect(onHeightChange).toHaveBeenLastCalledWith(80, { initial: false })
    } finally {
      ro.restore()
    }
  })

  it("flags only the first measurement as initial, even when it drifts", () => {
    const ro = installManualResizeObserver()
    try {
      const onHeightChange = vi.fn()
      // Pre-paint initial measure drifts (120 -> 80, initial: true); then a
      // later runtime change must NOT be flagged initial.
      render(<Harness onHeightChange={onHeightChange} zoneHeight="120px" />)
      expect(onHeightChange).toHaveBeenLastCalledWith(80, { initial: true })

      ro.fire(160)
      expect(onHeightChange).toHaveBeenCalledTimes(2)
      expect(onHeightChange).toHaveBeenLastCalledWith(160, { initial: false })
    } finally {
      ro.restore()
    }
  })

  it("mirrors the live height onto :root, replacing the boot approximation", () => {
    const ro = installManualResizeObserver()
    try {
      // What `applyPersistedComposerHeight` leaves at boot: a previous session's
      // long draft. Surfaces outside every editor zone (the call dock's chips,
      // the incoming ring) read this, so it must not survive the first measure.
      document.documentElement.style.setProperty("--composer-height", "350px")
      render(<Harness onHeightChange={() => {}} />)
      expect(rootHeight()).toBe("80px")

      ro.fire(132)
      expect(rootHeight()).toBe("132px")
    } finally {
      ro.restore()
    }
  })

  it("gives :root to the most recently measured zone, and to the survivor when it unmounts", () => {
    const ro = installTargetedResizeObserver()
    try {
      const { getByTestId, rerender } = render(<TwoZones showPanel />)
      const main = getByTestId("main-composer")
      const panel = getByTestId("panel-composer")

      ro.fireFor(panel, 240)
      expect(rootHeight()).toBe("240px")

      ro.fireFor(main, 96)
      expect(rootHeight()).toBe("96px")

      ro.fireFor(panel, 240)
      expect(rootHeight()).toBe("240px")

      // Panel closes: fall back to the main composer's real height, not the
      // panel's last measurement and not the boot value.
      rerender(<TwoZones showPanel={false} />)
      expect(rootHeight()).toBe("96px")
    } finally {
      ro.restore()
    }
  })
})
