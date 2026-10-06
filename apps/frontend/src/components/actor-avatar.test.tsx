import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@testing-library/react"
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

describe("ActorAvatar status expiry", () => {
  afterEach(() => vi.useRealTimers())

  it("drops a status badge when it expires, without a parent re-render", () => {
    vi.useFakeTimers()
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    vi.spyOn(hooks, "useActors").mockReturnValue({
      getActorAvatar: () => ({
        fallback: "KR",
        status: Date.now() < Date.parse(expiresAt) ? { emoji: "🌴", text: "Away", expiresAt } : undefined,
      }),
    } as unknown as ReturnType<typeof hooks.useActors>)

    const { queryByText } = render(<ActorAvatar actorId="usr_1" actorType="user" workspaceId="ws_1" />)
    expect(queryByText("🌴")).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(60_000))
    expect(queryByText("🌴")).not.toBeInTheDocument()
  })
})
