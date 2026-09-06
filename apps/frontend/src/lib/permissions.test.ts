import { describe, it, expect } from "vitest"
import { WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import { hasPermission } from "./permissions"

describe("hasPermission", () => {
  it("returns true when the slug is present", () => {
    const slugs = [WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ, WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE]
    expect(hasPermission(slugs, WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)).toBe(true)
  })

  it("returns false when the slug is absent", () => {
    const slugs = [WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ]
    expect(hasPermission(slugs, WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)).toBe(false)
  })

  it("returns false for an empty list", () => {
    expect(hasPermission([], WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ)).toBe(false)
  })

  it("returns false when permissions are undefined (bootstrap not yet hydrated)", () => {
    expect(hasPermission(undefined, WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ)).toBe(false)
  })
})
