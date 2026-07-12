import { vi } from "vitest"

// Radix Avatar.Image only renders its <img> once an off-screen preload reports
// "loaded"; in jsdom that never fires on its own, so stub window.Image to report
// loaded synchronously when a src is assigned. Radix resolves "loaded" from
// complete + naturalWidth, not just a load event.
class MockImage {
  private _src = ""
  complete = false
  naturalWidth = 0
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  set src(value: string) {
    this._src = value
    this.complete = true
    this.naturalWidth = 1
  }
  get src() {
    return this._src
  }
}

/**
 * Make image loads resolve synchronously so image-vs-fallback precedence is
 * observable in jsdom. Pair with `vi.unstubAllGlobals()` in `afterEach`.
 */
export function stubImageLoading(): void {
  vi.stubGlobal("Image", MockImage)
}
