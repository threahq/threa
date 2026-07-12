import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { PersonaAvatar } from "./persona-avatar"

// Radix Avatar.Image only renders its <img> once an off-screen preload reports
// "loaded"; in jsdom that never fires on its own, so stub window.Image to resolve
// synchronously when a src is assigned. This lets the image-vs-fallback precedence
// be observed at all.
class MockImage {
  private _src = ""
  complete = false
  naturalWidth = 0
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  set src(value: string) {
    this._src = value
    // Radix resolves "loaded" from complete + naturalWidth, not just an event.
    this.complete = true
    this.naturalWidth = 1
  }
  get src() {
    return this._src
  }
}

describe("PersonaAvatar", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", MockImage)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("renders the Ariadne SVG icon (not an emoji) for the built-in", () => {
    const { container } = render(<PersonaAvatar slug="ariadne" fallback="🧵" />)
    expect(container.querySelector("svg")).toBeInTheDocument()
    expect(screen.queryByText("🧵")).not.toBeInTheDocument()
  })

  it("renders the emoji fallback for a non-Ariadne persona with no image", () => {
    const { container } = render(<PersonaAvatar slug="researcher" fallback="🔬" />)
    expect(screen.getByText("🔬")).toBeInTheDocument()
    expect(container.querySelector("svg")).not.toBeInTheDocument()
  })

  it("renders initials when there is neither an icon nor an emoji", () => {
    render(<PersonaAvatar slug="researcher" fallback="R" />)
    expect(screen.getByText("R")).toBeInTheDocument()
  })

  it("renders the uploaded image over the fallback when an avatarUrl is set", async () => {
    const { container } = render(
      <PersonaAvatar
        slug="researcher"
        avatarUrl="/api/workspaces/ws_1/personas/persona_c1/avatar/1.64.webp"
        fallback="🔬"
      />
    )
    // The image is decorative (alt=""), so query the element directly.
    await waitFor(() => {
      const img = container.querySelector("img")
      expect(img).toHaveAttribute("src", "/api/workspaces/ws_1/personas/persona_c1/avatar/1.64.webp")
    })
  })
})
