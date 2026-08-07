import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card"

describe("HoverCardContent", () => {
  it("portals content outside its trigger's stacking context", () => {
    render(
      <div data-testid="stacking-context">
        <HoverCard open>
          <HoverCardTrigger>Open</HoverCardTrigger>
          <HoverCardContent>Reminder options</HoverCardContent>
        </HoverCard>
      </div>
    )

    const stackingContext = screen.getByTestId("stacking-context")
    const content = screen.getByText("Reminder options")

    expect(stackingContext).not.toContainElement(content)
    expect(document.body).toContainElement(content)
  })
})
