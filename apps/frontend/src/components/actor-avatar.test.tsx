import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import * as hooks from "@/hooks"
import * as personaAvatarModule from "@/components/persona-avatar"
import { ActorAvatar } from "./actor-avatar"

describe("ActorAvatar persona branch", () => {
  it("forwards the resolved avatarUrl to PersonaAvatar (custom persona images must reach the timeline)", () => {
    vi.spyOn(hooks, "useActors").mockReturnValue({
      getActorAvatar: () => ({
        fallback: "🐹",
        slug: "stefan",
        avatarUrl: "/api/workspaces/ws_1/personas/persona_1/avatar/123.64.webp",
      }),
    } as unknown as ReturnType<typeof hooks.useActors>)
    const personaAvatar = vi.spyOn(personaAvatarModule, "PersonaAvatar")

    render(<ActorAvatar actorId="persona_1" actorType="persona" workspaceId="ws_1" />)

    expect(personaAvatar).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "stefan",
        avatarUrl: "/api/workspaces/ws_1/personas/persona_1/avatar/123.64.webp",
        fallback: "🐹",
      }),
      undefined
    )
  })
})
