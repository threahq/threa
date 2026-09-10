import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  accountHomePath,
  clearAllLastWorkspaceIds,
  clearLastWorkspaceId,
  getLastWorkspaceId,
  setLastWorkspaceId,
} from "./last-workspace"

describe("last-workspace", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it("round-trips the last workspace id per account", () => {
    setLastWorkspaceId("workos_A", "ws_a")
    setLastWorkspaceId("workos_B", "ws_b")
    expect([getLastWorkspaceId("workos_A"), getLastWorkspaceId("workos_B")]).toEqual(["ws_a", "ws_b"])
  })

  it("returns null when that account has no recorded workspace", () => {
    setLastWorkspaceId("workos_A", "ws_a")
    expect(getLastWorkspaceId("workos_B")).toBeNull()
  })

  it("clears one account's pointer without touching another's", () => {
    setLastWorkspaceId("workos_A", "ws_a")
    setLastWorkspaceId("workos_B", "ws_b")
    clearLastWorkspaceId("workos_A")
    expect([getLastWorkspaceId("workos_A"), getLastWorkspaceId("workos_B")]).toEqual([null, "ws_b"])
  })

  it("clears every account's pointer on a full sign-out", () => {
    setLastWorkspaceId("workos_A", "ws_a")
    setLastWorkspaceId("workos_B", "ws_b")
    clearAllLastWorkspaceIds()
    expect([getLastWorkspaceId("workos_A"), getLastWorkspaceId("workos_B")]).toEqual([null, null])
  })

  it("never adopts the ownerless pre-multi-account pointer, and drops it on the next write", () => {
    localStorage.setItem("threa-last-workspace", "ws_unknown_owner")
    expect(accountHomePath("workos_A")).toBe("/workspaces")

    setLastWorkspaceId("workos_A", "ws_a")
    expect(localStorage.getItem("threa-last-workspace")).toBeNull()
  })

  it("lands a switched-to account on its own workspace, or the list when it has none", () => {
    setLastWorkspaceId("workos_A", "ws_a")
    expect([accountHomePath("workos_A"), accountHomePath("workos_B")]).toEqual(["/w/ws_a", "/workspaces"])
  })
})
