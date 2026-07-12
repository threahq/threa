import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { stubImageLoading } from "@/test"
import { PersonaAvatar } from "./persona-avatar"

describe("PersonaAvatar", () => {
  beforeEach(() => {
    stubImageLoading()
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
