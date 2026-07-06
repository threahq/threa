import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router-dom"
import type { BriefUpdatedEventPayload, StreamEvent } from "@threa/types"
import * as hooksModule from "@/hooks"
import { BriefUpdatedEvent } from "./brief-updated-event"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: () => "Ariadne",
  } as unknown as ReturnType<typeof hooksModule.useActors>)
})

function briefEvent(payload: BriefUpdatedEventPayload): StreamEvent {
  return {
    id: "evt_brief",
    streamId: "stream_root",
    sequence: "30",
    broadcastSequence: "15",
    eventType: "brief_updated",
    actorId: "persona_system_ariadne",
    actorType: "persona",
    createdAt: new Date().toISOString(),
    payload,
  }
}

/** Surfaces the current URL so the deep-link assertion can read the settings params. */
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="loc">{location.search}</div>
}

function renderEvent(payload: BriefUpdatedEventPayload) {
  return render(
    <MemoryRouter>
      <BriefUpdatedEvent event={briefEvent(payload)} workspaceId="ws_1" streamId="stream_root" />
      <LocationProbe />
    </MemoryRouter>
  )
}

describe("BriefUpdatedEvent", () => {
  it("renders the actor, 'updated', and the reason for a versioned write", () => {
    renderEvent({ briefId: "sbrf_1", version: 4, reason: "recorded the weekly-ship decision" })

    expect(screen.getByText(/Ariadne/)).toBeInTheDocument()
    expect(screen.getByText(/updated/)).toBeInTheDocument()
    expect(screen.getByText(/recorded the weekly-ship decision/)).toBeInTheDocument()
  })

  it("says 'created' for the first version and omits a reason when null", () => {
    renderEvent({ briefId: "sbrf_1", version: 1, reason: null })

    expect(screen.getByText(/created/)).toBeInTheDocument()
    expect(screen.queryByText(/—/)).not.toBeInTheDocument()
  })

  it("deep-links into the Companion settings tab where the brief lives (INV-40: an action button)", async () => {
    renderEvent({ briefId: "sbrf_1", version: 2, reason: null })

    await userEvent.click(screen.getByRole("button", { name: "stream brief" }))

    const search = screen.getByTestId("loc").textContent ?? ""
    const params = new URLSearchParams(search)
    expect(params.get("stream-settings")).toBe("companion")
    expect(params.get("sid")).toBe("stream_root")
  })

  it("renders nothing when the payload is missing", () => {
    const { container } = render(
      <MemoryRouter>
        <BriefUpdatedEvent
          event={{ ...briefEvent({ briefId: "x", version: 1, reason: null }), payload: undefined } as StreamEvent}
          workspaceId="ws_1"
          streamId="stream_root"
        />
      </MemoryRouter>
    )
    expect(container).toBeEmptyDOMElement()
  })
})
