import { describe, it, expect } from "bun:test"
import { DecisionsAvailability } from "./decisions-availability"
import { DecisionsRequestError } from "./decisions"

describe("DecisionsAvailability", () => {
  it("holds callers off after a failure and lets them back once the cooldown passes", async () => {
    const availability = new DecisionsAvailability(20)

    const fresh = availability.isAvailable
    availability.recordFailure(new Error("socket hang up"))
    const duringCooldown = availability.isAvailable
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect({ fresh, duringCooldown, afterCooldown: availability.isAvailable }).toEqual({
      fresh: true,
      duringCooldown: false,
      afterCooldown: true,
    })
  })

  it("keeps callers on the endpoint when it refused one request rather than went down", () => {
    const availability = new DecisionsAvailability()

    availability.recordFailure(new DecisionsRequestError(403, "<!DOCTYPE html>"))
    const afterRejection = availability.isAvailable
    availability.recordFailure(new DecisionsRequestError(429, "rate limited"))

    expect({ afterRejection, afterRateLimit: availability.isAvailable }).toEqual({
      afterRejection: true,
      afterRateLimit: false,
    })
  })

  it("holds callers off when every request would fail, like a revoked key", () => {
    const availability = new DecisionsAvailability()

    availability.recordFailure(new DecisionsRequestError(401, "unauthorized"))

    expect(availability.isAvailable).toBe(false)
  })
})
