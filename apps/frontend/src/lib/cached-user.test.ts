import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearAllCachedIdentities,
  clearCachedIdentity,
  getActiveAccountId,
  getCachedIdentity,
  setActiveAccountId,
  setCachedIdentity,
} from "./cached-user"

const ADA = { id: "workos_A", email: "ada@example.com", name: "Ada" }
const BEA = { id: "workos_B", email: "bea@example.com", name: "Bea" }

describe("cached account identities", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it("round-trips one account's display identity", () => {
    setCachedIdentity(ADA)
    expect(getCachedIdentity("workos_A")).toEqual(ADA)
  })

  it("returns null when nothing is cached for that account", () => {
    setCachedIdentity(ADA)
    expect(getCachedIdentity("workos_B")).toBeNull()
  })

  it("keeps each signed-in account's identity separate", () => {
    setCachedIdentity(ADA)
    setCachedIdentity(BEA)
    expect([getCachedIdentity("workos_A"), getCachedIdentity("workos_B")]).toEqual([ADA, BEA])
  })

  it("tracks the active account and forgets only that one on sign-out", () => {
    setCachedIdentity(ADA)
    setCachedIdentity(BEA)
    setActiveAccountId("workos_A")
    expect(getActiveAccountId()).toBe("workos_A")

    clearCachedIdentity("workos_A")
    expect({
      active: getActiveAccountId(),
      a: getCachedIdentity("workos_A"),
      b: getCachedIdentity("workos_B"),
    }).toEqual({ active: null, a: null, b: BEA })
  })

  it("forgets every account when signing out of all of them", () => {
    setCachedIdentity(ADA)
    setCachedIdentity(BEA)
    setActiveAccountId("workos_B")

    clearAllCachedIdentities()
    expect({
      active: getActiveAccountId(),
      a: getCachedIdentity("workos_A"),
      b: getCachedIdentity("workos_B"),
    }).toEqual({ active: null, a: null, b: null })
  })

  it("adopts the pre-multi-account record under the id it names, and only that id", () => {
    localStorage.setItem("threa-cached-user", JSON.stringify(ADA))
    expect({
      active: getActiveAccountId(),
      a: getCachedIdentity("workos_A"),
      b: getCachedIdentity("workos_B"),
    }).toEqual({ active: "workos_A", a: ADA, b: null })
  })

  it("drops the legacy record once that account is written in the new format", () => {
    localStorage.setItem("threa-cached-user", JSON.stringify(ADA))
    setCachedIdentity({ ...ADA, name: "Ada L" })
    expect(localStorage.getItem("threa-cached-user")).toBeNull()
    expect(getCachedIdentity("workos_A")).toEqual({ ...ADA, name: "Ada L" })
  })

  it("rejects a partial / malformed payload instead of returning a half user", () => {
    localStorage.setItem("threa-account-identity:workos_A", JSON.stringify({ id: "workos_A", email: "a@b.co" }))
    expect(getCachedIdentity("workos_A")).toBeNull()
  })

  it("returns null on unparseable JSON rather than throwing", () => {
    localStorage.setItem("threa-account-identity:workos_A", "{not json")
    expect(getCachedIdentity("workos_A")).toBeNull()
  })
})
