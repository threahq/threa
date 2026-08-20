import { describe, it, expect } from "vitest"
import { planRingCancel } from "./call-ring-cancel"

describe("planRingCancel", () => {
  it("closes without a fallback when a tagged ring notification is shown", () => {
    expect(planRingCancel(1, { attemptId: "callinv_1" })).toEqual({ show: false })
  })

  it("shows a silent, non-vibrating Call ended fallback when the cancel collapsed an unshown ring", () => {
    const plan = planRingCancel(0, { attemptId: "callinv_1", inviterName: "Ada" })
    expect(plan).toMatchObject({
      show: true,
      title: "Ada's call ended",
      // Reuses the ring tag so a late ring push replaces it; quiet close.
      options: { tag: "call-callinv_1", silent: true, renotify: false },
    })
    // Never vibrates — the ring is over.
    expect((plan as Extract<typeof plan, { show: true }>).options).not.toHaveProperty("vibrate")
  })

  it("falls back to a generic title when no inviter name is present", () => {
    const plan = planRingCancel(0, { attemptId: "callinv_1" })
    expect(plan).toMatchObject({ show: true, title: "Call ended" })
  })

  it("should say the call was answered when the settle outcome is accepted", () => {
    // Tapping the ring notification closes it, so the accept's own settle push
    // finds nothing to close — "call ended" here read as the caller hanging up.
    const plan = planRingCancel(0, { attemptId: "callinv_1", inviterName: "Ada", outcome: "accepted" })
    expect(plan).toMatchObject({ show: true, title: "Call answered", options: { silent: true } })
  })

  it("should say the call was declined when the settle outcome is declined", () => {
    const plan = planRingCancel(0, { attemptId: "callinv_1", inviterName: "Ada", outcome: "declined" })
    expect(plan).toMatchObject({ show: true, title: "Call declined" })
  })

  it("should keep the ended copy for caller-side outcomes", () => {
    expect(planRingCancel(0, { inviterName: "Ada", outcome: "cancelled" })).toMatchObject({
      title: "Ada's call ended",
    })
    expect(planRingCancel(0, { inviterName: "Ada", outcome: "expired" })).toMatchObject({
      title: "Ada's call ended",
    })
    expect(planRingCancel(0, { inviterName: "Ada", outcome: "superseded" })).toMatchObject({
      title: "Ada's call ended",
    })
  })
})
