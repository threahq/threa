import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useVisualViewport } from "./use-visual-viewport"

/**
 * Minimal EventTarget-based stand-in for VisualViewport. jsdom does not implement
 * the API, so tests drive it by dispatching synthetic resize events on this stub.
 */
class FakeVisualViewport extends EventTarget {
  height: number
  width: number
  offsetTop: number
  offsetLeft: number
  pageLeft: number
  pageTop: number
  scale: number
  constructor(height: number) {
    super()
    this.height = height
    this.width = 360
    this.offsetTop = 0
    this.offsetLeft = 0
    this.pageLeft = 0
    this.pageTop = 0
    this.scale = 1
  }
  emitResize() {
    this.dispatchEvent(new Event("resize"))
  }
}

const INNER_HEIGHT_DEFAULT = 800
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport")
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight")

let fakeVV: FakeVisualViewport
let innerHeight: number

function setInnerHeight(h: number) {
  innerHeight = h
}

describe("useVisualViewport", () => {
  beforeEach(() => {
    innerHeight = INNER_HEIGHT_DEFAULT
    fakeVV = new FakeVisualViewport(INNER_HEIGHT_DEFAULT)

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      get: () => innerHeight,
    })
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      get: () => fakeVV,
    })

    document.documentElement.style.removeProperty("--viewport-height")
  })

  afterEach(() => {
    if (originalVisualViewport) {
      Object.defineProperty(window, "visualViewport", originalVisualViewport)
    } else {
      Reflect.deleteProperty(window, "visualViewport")
    }
    if (originalInnerHeight) {
      Object.defineProperty(window, "innerHeight", originalInnerHeight)
    }
    document.documentElement.style.removeProperty("--viewport-height")
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("pins --viewport-height in pixels immediately on mount even when no keyboard is open", () => {
    fakeVV.height = 740

    const { result } = renderHook(() => useVisualViewport(true))

    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("740px")
    // No keyboard should be reported — this is steady-state, not a keyboard event.
    expect(result.current).toBe(false)
  })

  it("tracks visualViewport resize events and updates --viewport-height", () => {
    fakeVV.height = 800
    renderHook(() => useVisualViewport(true))
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("800px")

    // Focus an input so the shrink is treated as a real keyboard open and
    // propagates to `--viewport-height` rather than being clamped as phantom.
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()

    act(() => {
      fakeVV.height = 520
      fakeVV.emitResize()
    })

    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("520px")

    input.remove()
  })

  it("reports keyboard open when the visual viewport shrinks well below layout viewport", () => {
    fakeVV.height = 800
    const { result } = renderHook(() => useVisualViewport(true))
    expect(result.current).toBe(false)

    // Focus an editable element first — the keyboard can only legitimately
    // open if an input in this page has focus. Without focus the shrink is
    // treated as a phantom (see "ignores phantom shrink…" test below).
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()

    // Chrome/Safari: layout viewport stays at innerHeight, visual shrinks.
    act(() => {
      fakeVV.height = 500
      fakeVV.emitResize()
    })
    expect(result.current).toBe(true)

    act(() => {
      fakeVV.height = 800
      fakeVV.emitResize()
    })
    expect(result.current).toBe(false)

    input.remove()
  })

  it("ignores phantom visual-viewport shrink when no editable element is focused", () => {
    // Repro for the PWA scroll-offset bug: Chrome on Android can briefly
    // report vv.height < innerHeight when the PWA is foregrounded after
    // another app had the OS keyboard up. No input in this document has
    // focus, so no keyboard for this page can be open — the shrink must
    // not propagate to `--viewport-height` (which AppShell sizes off).
    fakeVV.height = 800
    const { result } = renderHook(() => useVisualViewport(true))
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("800px")

    act(() => {
      fakeVV.height = 500
      fakeVV.emitResize()
    })

    expect(result.current).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("800px")
  })

  it("recognizes a real keyboard the moment focus moves to an editable element", () => {
    // Same shrink as the phantom test, but with focus on an input — the
    // hook must treat it as a real keyboard open, shrink `--viewport-height`
    // accordingly, and flip `isKeyboardOpen` to true.
    fakeVV.height = 800
    const { result } = renderHook(() => useVisualViewport(true))

    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()

    act(() => {
      fakeVV.height = 500
      fakeVV.emitResize()
    })

    expect(result.current).toBe(true)
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("500px")

    input.remove()
  })

  it("treats a contenteditable focus as a legitimate keyboard surface", () => {
    // ProseMirror (composer, editor) uses contenteditable rather than INPUT
    // or TEXTAREA. The focus check must accept it the same way. jsdom does
    // not implement `isContentEditable`, so we polyfill the getter on the
    // element for this test — the real DOM exposes it natively.
    fakeVV.height = 800
    const { result } = renderHook(() => useVisualViewport(true))

    const editable = document.createElement("div")
    editable.contentEditable = "true"
    Object.defineProperty(editable, "isContentEditable", { configurable: true, get: () => true })
    editable.tabIndex = 0 // make it focusable in jsdom
    document.body.appendChild(editable)
    editable.focus()
    expect(document.activeElement).toBe(editable)

    act(() => {
      fakeVV.height = 500
      fakeVV.emitResize()
    })

    expect(result.current).toBe(true)
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("500px")

    editable.remove()
  })

  it("detects keyboard via the baseline fallback when both viewports shrink together", () => {
    // Firefox Android (and Chrome with interactive-widget=resizes-content) shrinks
    // both innerHeight and visualViewport.height when the keyboard opens.
    setInnerHeight(800)
    fakeVV.height = 800
    const { result } = renderHook(() => useVisualViewport(true))
    expect(result.current).toBe(false)

    act(() => {
      setInnerHeight(500)
      fakeVV.height = 500
      window.dispatchEvent(new Event("resize"))
    })

    expect(result.current).toBe(true)
  })

  it("re-measures on pageshow so BFCache restores do not linger with a stale height", async () => {
    fakeVV.height = 800
    renderHook(() => useVisualViewport(true))
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("800px")

    // Simulate a BFCache restore: imagine Chrome's dvh is stale but visualViewport
    // now reports the correct URL-bar-visible height. pageshow should re-measure
    // via the poll loop, which is driven by requestAnimationFrame.
    await act(async () => {
      fakeVV.height = 712
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))
      // Let one rAF tick the poll callback.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("712px")
  })

  it("does not let a mid-animation visualViewport scroll freeze a stale height (iOS keyboard close)", async () => {
    // iOS Safari emits visualViewport `scroll` events while the keyboard-hide
    // animation un-pans the page. Those must not cancel the in-flight
    // focus-transition poll: if they did, --viewport-height would freeze at the
    // still-collapsed mid-animation height and the bottom-anchored composer
    // would float above a dead keyboard-sized gap (the reported iOS bug).
    const getVH = () => document.documentElement.style.getPropertyValue("--viewport-height")
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    fakeVV.height = 800
    const { result } = renderHook(() => useVisualViewport(true))
    expect(getVH()).toBe("800px")

    // Composer is a contenteditable. Dismissing the keyboard by scrolling the
    // message list keeps it focused, so the phantom-shrink clamp (which only
    // applies when nothing is focused) cannot mask a stale height here.
    const editable = document.createElement("div")
    editable.contentEditable = "true"
    Object.defineProperty(editable, "isContentEditable", { configurable: true, get: () => true })
    editable.tabIndex = 0
    document.body.appendChild(editable)
    editable.focus()

    // Keyboard opens.
    act(() => {
      fakeVV.height = 500
      fakeVV.emitResize()
    })
    expect(getVH()).toBe("500px")
    expect(result.current).toBe(true)

    await act(async () => {
      // Focus churn around dismissal starts the keyboard-transition poll.
      editable.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
      await nextFrame()

      // visualViewport scroll fires while height is still collapsed. With the
      // old shared raf handle this cancelled the poll and pinned 500px.
      fakeVV.dispatchEvent(new Event("scroll"))
      await nextFrame()

      // Viewport settles to full height but iOS emits no further resize
      // (page is idle; html/body overflow:hidden blocks scroll recovery).
      // Only a still-alive poll can pick this up.
      fakeVV.height = 800
      for (let i = 0; i < 6; i++) await nextFrame()
      // Growth is debounced (see GROWTH_DEBOUNCE_MS) — wait out the settle
      // window so the final height lands.
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
    })

    expect(getVH()).toBe("800px")
    expect(result.current).toBe(false)

    editable.remove()
  })

  it("debounces viewport growth into a single settled write (Chrome Android keyboard close)", () => {
    // Chrome on Android steps visualViewport.height through several
    // intermediate values while the keyboard closes — including a transient
    // overshoot past the real screen height (753px captured on a 725px
    // screen). Each chunk written into --viewport-height is a visible layout
    // stutter, and the overshoot sizes the app taller than the screen,
    // pushing the bottom-anchored composer below the fold. Growth must wait
    // until the value holds still and land once, at the settled height.
    vi.useFakeTimers()
    const getVH = () => document.documentElement.style.getPropertyValue("--viewport-height")

    // Keyboard-open steady state. interactive-widget=resizes-content resizes
    // both viewports together, so innerHeight tracks vv.height throughout.
    setInnerHeight(436)
    fakeVV.height = 436
    renderHook(() => useVisualViewport(true))
    expect(getVH()).toBe("436px")

    // First close chunk — must not reach layout.
    act(() => {
      setInnerHeight(521)
      fakeVV.height = 521
      fakeVV.emitResize()
    })
    expect(getVH()).toBe("436px")

    // A later chunk (the overshoot) reschedules the settle window.
    act(() => vi.advanceTimersByTime(100))
    act(() => {
      setInnerHeight(753)
      fakeVV.height = 753
      fakeVV.emitResize()
    })
    act(() => vi.advanceTimersByTime(100))
    expect(getVH()).toBe("436px")

    // The viewport settles on the real height; the debounce re-measures at
    // fire time, so the overshoot is never written — only the final value.
    act(() => {
      setInnerHeight(725)
      fakeVV.height = 725
      fakeVV.emitResize()
    })
    act(() => vi.advanceTimersByTime(200))
    expect(getVH()).toBe("725px")
  })

  it("applies a shrink immediately even while a growth is pending (keyboard reopens mid-close)", () => {
    vi.useFakeTimers()
    const getVH = () => document.documentElement.style.getPropertyValue("--viewport-height")

    setInnerHeight(436)
    fakeVV.height = 436
    renderHook(() => useVisualViewport(true))
    expect(getVH()).toBe("436px")

    // Close starts (growth → debounced)…
    act(() => {
      setInnerHeight(725)
      fakeVV.height = 725
      fakeVV.emitResize()
    })
    expect(getVH()).toBe("436px")

    // …but the user refocuses and the keyboard comes straight back: the
    // shrink lands synchronously, never waiting out the growth debounce.
    act(() => {
      setInnerHeight(420)
      fakeVV.height = 420
      fakeVV.emitResize()
    })
    expect(getVH()).toBe("420px")

    act(() => vi.advanceTimersByTime(300))
    expect(getVH()).toBe("420px")
  })

  it("restores the full height immediately on blur and ignores stale keyboard-open reports", async () => {
    // The keyboard close is certain the moment focus leaves the last editable.
    // Waiting for the browser's chunked viewport reports (plus the growth
    // debounce) made the composer trail the keyboard by several hundred ms —
    // the height must be restored optimistically on focusout, and the
    // keyboard-open-sized values the browser still reports during its close
    // animation must not yank it back down.
    const getVH = () => document.documentElement.style.getPropertyValue("--viewport-height")
    const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

    setInnerHeight(800)
    fakeVV.height = 800
    renderHook(() => useVisualViewport(true))

    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()

    act(() => {
      fakeVV.height = 500
      fakeVV.emitResize()
    })
    expect(getVH()).toBe("500px")

    await act(async () => {
      input.blur()
      await nextTask()
    })
    expect(getVH()).toBe("800px")

    // Mid-close the browser still reports keyboard-open heights (both
    // viewports, resizes-content style, so the phantom clamp doesn't apply)
    // — suppressed inside the optimistic window.
    act(() => {
      setInnerHeight(520)
      fakeVV.height = 520
      fakeVV.emitResize()
    })
    expect(getVH()).toBe("800px")

    // The close settles on the value we already wrote — no further movement.
    act(() => {
      setInnerHeight(800)
      fakeVV.height = 800
      fakeVV.emitResize()
    })
    expect(getVH()).toBe("800px")

    input.remove()
  })

  it("freezes the close-overshoot growth and reconciles once at window end (Chrome close jump)", async () => {
    // The Chrome close jump: after the optimistic restore to 800, Chrome
    // transiently reports a height PAST the real screen (the 753-on-725
    // overshoot). As a growth above the restored baseline it used to sail
    // through the debounce and get written — composer below the fold — and
    // its shrink-correction was then suppressed until the window expired.
    // The whole window must be write-frozen, with one reconcile at expiry.
    const getVH = () => document.documentElement.style.getPropertyValue("--viewport-height")
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

    setInnerHeight(800)
    fakeVV.height = 800
    renderHook(() => useVisualViewport(true))

    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()
    act(() => {
      fakeVV.height = 500
      fakeVV.emitResize()
    })
    expect(getVH()).toBe("500px")

    await act(async () => {
      input.blur()
      await sleep(20)
    })
    expect(getVH()).toBe("800px")

    // Mid-close overshoot past the restored baseline — must NOT be written,
    // not even after the growth debounce elapses.
    await act(async () => {
      setInnerHeight(828)
      fakeVV.height = 828
      fakeVV.emitResize()
      await sleep(250)
    })
    expect(getVH()).toBe("800px")

    // The viewport settles back on the real height before the freeze ends;
    // the reconcile at window expiry confirms the baseline — no movement.
    await act(async () => {
      setInnerHeight(800)
      fakeVV.height = 800
      fakeVV.emitResize()
      await sleep(400)
    })
    expect(getVH()).toBe("800px")

    input.remove()
  })

  it("skips the optimistic close restore when focus hops to another editable", async () => {
    const getVH = () => document.documentElement.style.getPropertyValue("--viewport-height")
    const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

    setInnerHeight(800)
    fakeVV.height = 800
    renderHook(() => useVisualViewport(true))

    const composer = document.createElement("input")
    const search = document.createElement("input")
    document.body.append(composer, search)
    composer.focus()

    act(() => {
      fakeVV.height = 500
      fakeVV.emitResize()
    })
    expect(getVH()).toBe("500px")

    // Focus moves composer → search: the keyboard stays up, so the deferred
    // restore must see the new editable focus and do nothing.
    await act(async () => {
      search.focus()
      await nextTask()
    })
    expect(getVH()).toBe("500px")

    composer.remove()
    search.remove()
  })

  it("cleans up listeners and removes --viewport-height on unmount", () => {
    fakeVV.height = 800
    const { unmount } = renderHook(() => useVisualViewport(true))
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("800px")

    unmount()

    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("")

    // After unmount, viewport events must no longer mutate the custom property.
    act(() => {
      fakeVV.height = 400
      fakeVV.emitResize()
      window.dispatchEvent(new Event("resize"))
    })
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("")
  })

  it("is a no-op when disabled", () => {
    fakeVV.height = 800
    const { result } = renderHook(() => useVisualViewport(false))

    expect(result.current).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("")

    act(() => {
      fakeVV.height = 500
      fakeVV.emitResize()
    })
    // Still untouched.
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("")
  })
})
