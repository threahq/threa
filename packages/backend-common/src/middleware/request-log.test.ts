import { describe, expect, it } from "bun:test"
import { requestLogSerializers } from "./request-log"

describe("requestLogSerializers.req", () => {
  it("should keep only id, method, url, and userAgent when headers carry secrets", () => {
    const stdSerializedRequest = {
      id: "req-1",
      method: "GET",
      url: "/api/v1/workspaces/ws_01WORKSPACE/streams?include=members",
      headers: {
        authorization: "Bearer secret-token",
        cookie: "session=abc",
        "x-internal-api-key": "internal-secret",
        "user-agent": "curl/8.0",
      },
      query: { include: "members" },
      params: { id: "ws_01WORKSPACE" },
      remoteAddress: "127.0.0.1",
      remotePort: 54321,
    }

    const result = requestLogSerializers.req(stdSerializedRequest)

    expect(result).toEqual({
      id: "req-1",
      method: "GET",
      url: "/api/v1/workspaces/ws_01WORKSPACE/streams?include=members",
      userAgent: "curl/8.0",
    })
  })
})

describe("requestLogSerializers.res", () => {
  it("should keep only statusCode when headers carry secrets", () => {
    const stdSerializedResponse = {
      statusCode: 403,
      headers: { "set-cookie": "session=abc; HttpOnly" },
    }

    const result = requestLogSerializers.res(stdSerializedResponse)

    expect(result).toEqual({ statusCode: 403 })
  })
})
