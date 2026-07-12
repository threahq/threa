import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"
import * as hooks from "@/hooks"
import { stubImageLoading } from "@/test"
import { ActorAvatar } from "./actor-avatar"

describe("ActorAvatar persona branch", () => {
  beforeEach(() => {
    stubImageLoading()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("renders the resolved avatar image (custom persona images must reach the timeline)", async () => {
    vi.spyOn(hooks, "useActors").mockReturnValue({
      getActorAvatar: () => ({
        fallback: "🐹",
        slug: "stefan",
        avatarUrl: "/api/workspaces/ws_1/personas/persona_1/avatar/123.64.webp",
      }),
    } as unknown as ReturnType<typeof hooks.useActors>)

    const { container } = render(<ActorAvatar actorId="persona_1" actorType="persona" workspaceId="ws_1" />)

    // The persona image is decorative (alt=""), so query the element directly.
    await waitFor(() => {
      const img = container.querySelector("img")
      expect(img).toHaveAttribute("src", "/api/workspaces/ws_1/personas/persona_1/avatar/123.64.webp")
    })
  })

  it("renders the emoji fallback when the persona has no image", () => {
    vi.spyOn(hooks, "useActors").mockReturnValue({
      getActorAvatar: () => ({ fallback: "🐹", slug: "stefan", avatarUrl: undefined }),
    } as unknown as ReturnType<typeof hooks.useActors>)

    const { getByText } = render(<ActorAvatar actorId="persona_1" actorType="persona" workspaceId="ws_1" />)

    expect(getByText("🐹")).toBeInTheDocument()
  })
})
