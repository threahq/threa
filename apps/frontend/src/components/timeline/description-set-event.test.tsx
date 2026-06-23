import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import type { DescriptionSetEventPayload, StreamEvent } from "@threa/types"
import * as hooksModule from "@/hooks"
import * as userProfileModule from "@/components/user-profile"
import { DescriptionSetEvent } from "./description-set-event"

const openUserProfile = vi.fn()

beforeEach(() => {
  vi.restoreAllMocks()
  openUserProfile.mockReset()
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: () => "Kristoffer Remback",
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({ openUserProfile })
})

function createEvent(payload: DescriptionSetEventPayload, overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: "evt_desc",
    streamId: "stream_1",
    sequence: "11",
    broadcastSequence: "8",
    eventType: "description_set",
    actorId: "usr_kris",
    actorType: "user",
    createdAt: new Date().toISOString(),
    payload,
    ...overrides,
  }
}

function renderEvent(event: StreamEvent) {
  return render(
    <MemoryRouter>
      <DescriptionSetEvent event={event} workspaceId="ws_1" />
    </MemoryRouter>
  )
}

describe("DescriptionSetEvent", () => {
  it("attributes the change to the actor and renders the description body as markdown", () => {
    renderEvent(createEvent({ descriptionMarkdown: "Hello **world**" }))

    expect(screen.getByText("Kristoffer Remback")).toBeInTheDocument()
    expect(screen.getByText(/set the description/)).toBeInTheDocument()
    // Body goes through the normal markdown pipeline, so **world** is emphasized.
    expect(screen.getByText("world").tagName).toBe("STRONG")
  })

  it("renders a cleared state when the description was removed", () => {
    renderEvent(createEvent({ descriptionMarkdown: null }))

    expect(screen.getByText(/cleared the description/)).toBeInTheDocument()
  })

  it("opens the actor's profile when their name is clicked (mention semantics)", async () => {
    renderEvent(createEvent({ descriptionMarkdown: "A note" }))

    await userEvent.click(screen.getByRole("button", { name: "Kristoffer Remback" }))

    expect(openUserProfile).toHaveBeenCalledWith("usr_kris")
  })

  it("does not make a non-user actor (system) clickable", () => {
    renderEvent(createEvent({ descriptionMarkdown: "A note" }, { actorId: null, actorType: "system" }))

    expect(screen.queryByRole("button", { name: "Kristoffer Remback" })).not.toBeInTheDocument()
    expect(screen.getByText("Kristoffer Remback")).toBeInTheDocument()
  })
})
