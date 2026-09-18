import { describe, it, expect } from "bun:test"
import { DecisionsAvailability } from "./decisions-availability"

describe("DecisionsAvailability", () => {
  it("holds callers off after a failure and lets them back once the cooldown passes", async () => {
    const availability = new DecisionsAvailability(20)

    const fresh = availability.isAvailable
    availability.recordFailure()
    const duringCooldown = availability.isAvailable
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect({ fresh, duringCooldown, afterCooldown: availability.isAvailable }).toEqual({
      fresh: true,
      duringCooldown: false,
      afterCooldown: true,
    })
  })
})
