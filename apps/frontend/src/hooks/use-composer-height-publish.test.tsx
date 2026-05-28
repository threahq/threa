import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useRef } from "react"
import { render } from "@testing-library/react"
import { useComposerHeightPublish } from "./use-composer-height-publish"

type ResizeCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void

function installManualResizeObserver(): {
  fire: (blockSize: number) => void
  restore: () => void
} {
  let lastCallback: ResizeCallback | null = null
  const original = global.ResizeObserver
  class ManualResizeObserver {
    constructor(cb: ResizeCallback) {
      lastCallback = cb
    }
    observe() {}
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

function Harness({ onHeightChange, active = true }: { onHeightChange: (px: number) => void; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useComposerHeightPublish(ref, { active, onHeightChange })
  return (
    <div data-editor-zone="main">
      <div ref={ref}>composer</div>
    </div>
  )
}

describe("useComposerHeightPublish", () => {
  let restoreRect: () => void

  beforeEach(() => {
    restoreRect = pinInitialHeight(80)
  })

  afterEach(() => {
    restoreRect()
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

  it("fires onHeightChange only when the height actually changes", () => {
    const ro = installManualResizeObserver()
    try {
      const onHeightChange = vi.fn()
      render(<Harness onHeightChange={onHeightChange} />)

      // Same height as the seeded baseline — no notification.
      ro.fire(80)
      expect(onHeightChange).not.toHaveBeenCalled()

      // Composer grows (e.g. multi-line draft / attachments settle).
      ro.fire(160)
      expect(onHeightChange).toHaveBeenCalledTimes(1)
      expect(onHeightChange).toHaveBeenLastCalledWith(160)

      // A redundant fire at the same height must not re-notify.
      ro.fire(160)
      expect(onHeightChange).toHaveBeenCalledTimes(1)

      // Composer shrinks back (message sent, draft cleared).
      ro.fire(80)
      expect(onHeightChange).toHaveBeenCalledTimes(2)
      expect(onHeightChange).toHaveBeenLastCalledWith(80)
    } finally {
      ro.restore()
    }
  })
})
