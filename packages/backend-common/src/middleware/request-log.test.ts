import { describe, expect, it } from "bun:test"
import { requestLogLevel, requestLogSerializers } from "./request-log"

describe("requestLogLevel", () => {
  it("should return the matching level when given each statusCode/err combination", () => {
    const cases: Array<[number, unknown]> = [
      [200, undefined],
      [400, undefined],
      [401, undefined],
      [403, undefined],
      [404, undefined],
      [429, undefined],
      [500, undefined],
      [200, new Error("boom")],
    ]

    expect(cases.map(([statusCode, err]) => requestLogLevel(statusCode, err))).toEqual([
      "silent",
      "warn",
      "info",
      "info",
      "info",
      "warn",
      "error",
      "error",
    ])
  })
})

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
