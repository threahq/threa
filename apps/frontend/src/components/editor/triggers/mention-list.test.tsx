import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { stubImageLoading } from "@/test"
import { MentionList } from "./mention-list"
import type { Mentionable } from "./types"

describe("MentionList persona rows", () => {
  beforeEach(() => {
    stubImageLoading()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("renders a custom persona's avatar image (not just the emoji fallback)", async () => {
    const items: Mentionable[] = [
      {
        id: "persona_1",
        slug: "stefan",
        name: "Stefan",
        type: "persona",
        avatarEmoji: "🐹",
        avatarUrl: "/api/workspaces/ws_1/personas/persona_1/avatar/123.64.webp",
      },
    ]

    const { container } = render(<MentionList items={items} clientRect={() => new DOMRect()} command={() => {}} />)

    await waitFor(() => {
      const img = container.querySelector("img")
      expect(img).toHaveAttribute("src", "/api/workspaces/ws_1/personas/persona_1/avatar/123.64.webp")
    })
  })

  it("falls back to the emoji when the persona has no image", () => {
    const items: Mentionable[] = [
      { id: "persona_2", slug: "ariadne-fork", name: "Fork", type: "persona", avatarEmoji: "🧵" },
    ]

    const { container, getByText } = render(
      <MentionList items={items} clientRect={() => new DOMRect()} command={() => {}} />
    )

    expect(getByText("🧵")).toBeInTheDocument()
    expect(container.querySelector("img")).not.toBeInTheDocument()
  })
})
