import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  cacheConnectivityAuthorization,
  clearConnectivityConsentTombstone,
  isConnectivityConsentTombstoned,
  readCachedConnectivityAuthorization,
  readPendingConnectivityRevocations,
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
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

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

  it("should preserve concurrent revocations for different scopes", () => {
    const otherConfig = { ...config, userId: "usr_2", workspaceId: "ws_2" }
    cacheConnectivityAuthorization("account_1", config, grantedAt, () => "grant_1")
    cacheConnectivityAuthorization("account_1", otherConfig, grantedAt, () => "grant_2")
    const originalSetItem = Storage.prototype.setItem
    let nested = false
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("threa-connectivity-diagnostics:revocation:") && !nested) {
        nested = true
        tombstoneConnectivityAuthorization("account_1", "ws_2", "scope_2", undefined, revokedAt)
      }
      return originalSetItem.call(this, key, value)
    })

    tombstoneConnectivityAuthorization("account_1", "ws_1", "scope_1", undefined, revokedAt)

    expect({
      first: readCachedConnectivityAuthorization("account_1", "ws_1"),
      second: readCachedConnectivityAuthorization("account_1", "ws_2"),
      pending: readPendingConnectivityRevocations().sort((left, right) => left.scope.localeCompare(right.scope)),
    }).toEqual({
      first: null,
      second: null,
      pending: [
        { scope: "scope_1", consentId: "grant_1" },
        { scope: "scope_2", consentId: "grant_2" },
      ],
    })
  })

  it("should reject a stale authorization write that completes after revocation", () => {
    cacheConnectivityAuthorization("account_1", config, grantedAt, () => "grant_1")
    const originalSetItem = Storage.prototype.setItem
    let revoked = false
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.includes(":authorization:") && !revoked) {
        revoked = true
        tombstoneConnectivityAuthorization("account_1", "ws_1", "scope_1", undefined, revokedAt)
      }
      return originalSetItem.call(this, key, value)
    })

    const stale = cacheConnectivityAuthorization("account_1", config, updatedAt, () => "stale")

    expect(stale).toBeNull()
    expect(readCachedConnectivityAuthorization("account_1", "ws_1")).toBeNull()
  })

  it("should keep a completed cleanup as a durable stale-grant block", () => {
    cacheConnectivityAuthorization("account_1", config, grantedAt, () => "grant_1")
    tombstoneConnectivityAuthorization("account_1", "ws_1", "scope_1", undefined, revokedAt)

    clearConnectivityConsentTombstone("grant_1")

    expect({
      pending: readPendingConnectivityRevocations(),
      tombstoned: isConnectivityConsentTombstoned("grant_1"),
      restored: readCachedConnectivityAuthorization("account_1", "ws_1"),
    }).toEqual({ pending: [], tombstoned: true, restored: null })
  })

  it("should bound independently stored revocations", () => {
    for (let index = 0; index < 110; index++) {
      const workspaceId = `ws_${index}`
      const scopedConfig = { ...config, workspaceId }
      cacheConnectivityAuthorization("account_1", scopedConfig, grantedAt, () => `grant_${index}`)
      tombstoneConnectivityAuthorization("account_1", workspaceId, `scope_${index}`, undefined, revokedAt)
    }

    expect(readPendingConnectivityRevocations()).toHaveLength(100)
    expect(readCachedConnectivityAuthorization("account_1", "ws_109")).toBeNull()
  })
})
