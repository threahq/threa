import { describe, expect, it } from "vitest"
import { DELEGATION_REOPEN_REASONS, DELEGATION_STATUSES } from "@threahq/types"
import {
  DELEGATION_REOPEN_REASON_LABEL,
  DELEGATION_STATUS_LABEL,
  DELEGATION_TERMINAL,
  delegationAvailabilityLabel,
  delegationStatusPillClass,
} from "./delegation-display"

describe("delegation display", () => {
  it("owns distinct copy for every reopen reason", () => {
    expect(DELEGATION_REOPEN_REASONS.map((reason) => DELEGATION_REOPEN_REASON_LABEL[reason])).toEqual([
      "Claim expired · Open again",
      "Claim released · Open again",
      "Requeued · Open",
    ])
  })

  it("uses reopen reasons only for open availability", () => {
    expect(delegationAvailabilityLabel("open", "claim_released")).toBe("Claim released · Open again")
    expect(delegationAvailabilityLabel("claimed", "claim_released")).toBe("Claimed")
    expect(delegationAvailabilityLabel("open")).toBe("Open")
  })

  it("exhaustively maps every status and keeps expired recoverable", () => {
    expect(
      DELEGATION_STATUSES.map((status) => [DELEGATION_STATUS_LABEL[status], delegationStatusPillClass(status)])
    ).toHaveLength(DELEGATION_STATUSES.length)
    expect(DELEGATION_STATUS_LABEL.expired).toBe("Claim expired")
    expect(DELEGATION_TERMINAL.has("expired")).toBe(false)
  })
})
