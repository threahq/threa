import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

function stubMatchMedia(coarsePrimary: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: coarse") ? coarsePrimary : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

function emitPointer(type: "pointerdown" | "pointermove", pointerType: string) {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, "pointerType", { value: pointerType })
  act(() => {
    window.dispatchEvent(event)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  document.documentElement.removeAttribute("data-input")
})

describe("useInputMode", () => {
  it("seeds from the primary pointer and mirrors it onto <html data-input>", async () => {
    stubMatchMedia(true)
    const { useInputMode } = await import("./use-input-mode")
    const { result } = renderHook(() => useInputMode())
    expect(result.current).toBe("touch")
    expect(document.documentElement.getAttribute("data-input")).toBe("touch")
  })

  it("flips to touch when a finger is used and back to mouse on mouse movement", async () => {
    stubMatchMedia(false) // primary reported as fine → starts "mouse"
    const { useInputMode } = await import("./use-input-mode")
    const { result } = renderHook(() => useInputMode())
    expect(result.current).toBe("mouse")

    emitPointer("pointerdown", "touch")
    expect(result.current).toBe("touch")
    expect(document.documentElement.getAttribute("data-input")).toBe("touch")

    // The crux: a mouse on a device the browser called "coarse" must win back.
    emitPointer("pointermove", "mouse")
    expect(result.current).toBe("mouse")
    expect(document.documentElement.getAttribute("data-input")).toBe("mouse")
  })

  it("treats a pen as a precise (mouse-like) pointer", async () => {
    stubMatchMedia(true)
    const { useInputMode } = await import("./use-input-mode")
    const { result } = renderHook(() => useInputMode())
    emitPointer("pointerdown", "pen")
    expect(result.current).toBe("mouse")
  })
})
