import { beforeEach, describe, expect, it } from "vitest"
import {
  cacheConnectivityAuthorization,
  readCachedConnectivityAuthorization,
  tombstoneConnectivityAuthorization,
} from "./consent-cache"

const config = {
  token: "phc_test",
  host: "https://eu.posthog.test",
  userId: "usr_1",
  workspaceId: "ws_1",
  region: "eu",
}
const grantedAt = "2026-09-09T20:00:00.000Z"
const updatedAt = "2026-09-09T20:01:00.000Z"
const revokedAt = "2026-09-09T20:02:00.000Z"

describe("cached connectivity consent", () => {
  beforeEach(() => localStorage.clear())

  it("should preserve the grant when an unrelated preference updates", () => {
    const original = cacheConnectivityAuthorization("account_1", config, grantedAt, () => "grant_1")!
    const updated = cacheConnectivityAuthorization("account_1", config, updatedAt, () => "grant_2")
    expect(updated).toEqual({ ...original, decisionVersion: updatedAt })
    expect(readCachedConnectivityAuthorization("account_1", "ws_1")).toEqual(updated)
  })

  it("should reject every preference snapshot older than the withdrawal", () => {
    cacheConnectivityAuthorization("account_1", config, grantedAt, () => "grant_1")
    tombstoneConnectivityAuthorization("account_1", "ws_1", "scope_1", undefined, revokedAt)
    expect([
      cacheConnectivityAuthorization("account_1", config, grantedAt, () => "stale_1"),
      cacheConnectivityAuthorization("account_1", config, updatedAt, () => "stale_2"),
      cacheConnectivityAuthorization("account_1", config, revokedAt, () => "stale_3"),
    ]).toEqual([null, null, null])
    expect(
      cacheConnectivityAuthorization("account_1", config, "2026-09-09T20:03:00.000Z", () => "grant_new")?.consentId
    ).toBe("grant_new")
  })
})
