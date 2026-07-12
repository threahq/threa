import { describe, expect, it } from "bun:test"
import { assertHandlerParity, toExpressPath } from "./mount"
import { PUBLIC_API_ROUTES } from "./routes"

describe("toExpressPath", () => {
  it("converts OpenAPI path params to Express params", () => {
    expect(toExpressPath("/api/v1/workspaces/{workspaceId}/streams/{streamId}/messages")).toBe(
      "/api/v1/workspaces/:workspaceId/streams/:streamId/messages"
    )
  })

  it("leaves paths without params unchanged", () => {
    expect(toExpressPath("/api/v1/workspaces/{workspaceId}/labels/assignments")).toBe(
      "/api/v1/workspaces/:workspaceId/labels/assignments"
    )
  })
})

describe("assertHandlerParity", () => {
  const registryIds = PUBLIC_API_ROUTES.map((route) => route.operationId)

  it("passes when handler keys exactly cover the registry", () => {
    expect(() => assertHandlerParity(registryIds)).not.toThrow()
  })

  it("throws when a registry route has no handler", () => {
    const missingOne = registryIds.filter((id) => id !== "sendMessage")
    expect(() => assertHandlerParity(missingOne)).toThrow(/missing handlers: sendMessage/)
  })

  it("throws when a handler has no registry route", () => {
    expect(() => assertHandlerParity([...registryIds, "ghostOperation"])).toThrow(
      /without a registry route: ghostOperation/
    )
  })
})
