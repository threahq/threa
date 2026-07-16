import { describe, expect, it } from "bun:test"
import { createWorkspaceSchema } from "../../src/features/workspaces/handlers"

describe("createWorkspaceSchema timezone", () => {
  it("accepts an IANA zone", () => {
    expect(createWorkspaceSchema.parse({ name: "Acme", timezone: "Asia/Tokyo" }).timezone).toBe("Asia/Tokyo")
  })

  it("treats the zone as optional", () => {
    expect(createWorkspaceSchema.parse({ name: "Acme" }).timezone).toBeUndefined()
  })

  it("rejects a zone the region would reject", () => {
    // The control plane must not enqueue a value its region will 400 on: the
    // regional-create call would fail permanently, leaving the workspace
    // registered here but never provisioned.
    expect(createWorkspaceSchema.safeParse({ name: "Acme", timezone: "Mars/Olympus" }).success).toBe(false)
    expect(createWorkspaceSchema.safeParse({ name: "Acme", timezone: "UTC+1" }).success).toBe(false)
    expect(createWorkspaceSchema.safeParse({ name: "Acme", timezone: "" }).success).toBe(false)
  })
})
