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
  it("should keep only id, method, url, userAgent, and origin when headers carry secrets", () => {
    const stdSerializedRequest = {
      id: "req-1",
      method: "GET",
      url: "/api/v1/workspaces/ws_01WORKSPACE/streams?include=members",
      headers: {
        authorization: "Bearer secret-token",
        cookie: "session=abc",
        "x-internal-api-key": "internal-secret",
        "user-agent": "curl/8.0",
        origin: "https://www.example.com",
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
      origin: "https://www.example.com",
    })
  })
})

describe("requestLogSerializers.req hook secret redaction", () => {
  const cases: Array<[name: string, url: string, expected: string]> = [
    [
      "should replace the secret segment when given a native hook url",
      "/api/v1/workspaces/ws_01W/hooks/hook_01H/s3cr3t-VALUE_x",
      "/api/v1/workspaces/ws_01W/hooks/hook_01H/[redacted]",
    ],
    [
      "should keep the translator suffix when given a slack hook url",
      "/api/v1/workspaces/ws_01W/hooks/hook_01H/s3cr3t-VALUE_x/slack",
      "/api/v1/workspaces/ws_01W/hooks/hook_01H/[redacted]/slack",
    ],
    [
      "should redact before the query string when given a hook url with query params",
      "/api/v1/workspaces/ws_01W/hooks/hook_01H/s3cr3t?retry=1",
      "/api/v1/workspaces/ws_01W/hooks/hook_01H/[redacted]?retry=1",
    ],
    [
      "should redact when given a mixed-case hook url, which express routes anyway",
      "/API/v1/workspaces/ws_01W/HOOKS/hook_01H/s3cr3t",
      "/API/v1/workspaces/ws_01W/HOOKS/hook_01H/[redacted]",
    ],
    [
      "should leave the url alone when given a non-hook url",
      "/api/v1/workspaces/ws_01W/streams/stream_01S/messages",
      "/api/v1/workspaces/ws_01W/streams/stream_01S/messages",
    ],
  ]

  for (const [name, url, expected] of cases) {
    it(name, () => {
      const result = requestLogSerializers.req({ id: "req-1", method: "POST", url, headers: {} })
      expect(result.url).toBe(expected)
    })
  }
})

describe("requestLogSerializers.req token redaction", () => {
  const cases: Array<[name: string, url: string, expected: string]> = [
    [
      "should replace the token when given an invite lookup url",
      "/api/stream-connections/lookup?token=tok_S3cr3t-x",
      "/api/stream-connections/lookup?token=[redacted]",
    ],
    [
      "should keep the other params when the token sits between them",
      "/api/invitations/lookup?a=1&token=tok_S3cr3t&b=2",
      "/api/invitations/lookup?a=1&token=[redacted]&b=2",
    ],
    ["should leave a param that only ends in token alone", "/api/things?next_token=abc", "/api/things?next_token=abc"],
    [
      "should replace the state when given a sign-in callback url",
      "/api/auth/callback?code=c&state=%2Fconnections%2Ftok_S3cr3t",
      "/api/auth/callback?code=c&state=[redacted]",
    ],
    [
      "should replace redirect_to when given a sign-in url",
      "/api/auth/login?redirect_to=%2Fconnections%2Ftok_S3cr3t",
      "/api/auth/login?redirect_to=[redacted]",
    ],
  ]

  for (const [name, url, expected] of cases) {
    it(name, () => {
      const result = requestLogSerializers.req({ id: "req-1", method: "GET", url, headers: {} })
      expect(result.url).toBe(expected)
    })
  }
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
