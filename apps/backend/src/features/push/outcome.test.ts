import { describe, it, expect } from "bun:test"
import { classifyProviderResult, providerFamily } from "./outcome"

const rejectedWith = (reason: unknown): PromiseSettledResult<unknown> => ({ status: "rejected", reason })
const webPushError = (statusCode: number) =>
  Object.assign(new Error("Received unexpected response code"), {
    statusCode,
    endpoint: "https://fcm.googleapis.com/fcm/send/secret-token",
    body: "secret body",
    headers: {},
  })

describe("classifyProviderResult", () => {
  it.each([
    [
      "a 201 response",
      { status: "fulfilled", value: { statusCode: 201, body: "", headers: {} } },
      "accepted",
      201,
      null,
    ],
    ["a resolution without a readable status", { status: "fulfilled", value: {} }, "accepted", null, null],
    ["404", rejectedWith(webPushError(404)), "registration_gone", 404, null],
    ["410", rejectedWith(webPushError(410)), "registration_gone", 410, null],
    ["401", rejectedWith(webPushError(401)), "rejected", 401, null],
    ["403", rejectedWith(webPushError(403)), "rejected", 403, null],
    ["400", rejectedWith(webPushError(400)), "rejected", 400, null],
    ["413", rejectedWith(webPushError(413)), "rejected", 413, null],
    ["429", rejectedWith(webPushError(429)), "unreachable", 429, null],
    ["500", rejectedWith(webPushError(500)), "unreachable", 500, null],
    ["503", rejectedWith(webPushError(503)), "unreachable", 503, null],
    [
      "a network error",
      rejectedWith(Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { code: "ETIMEDOUT" })),
      "unreachable",
      null,
      "ETIMEDOUT",
    ],
    ["a non-object rejection", rejectedWith("boom"), "unreachable", null, null],
    [
      "an error whose code is not a short system code",
      rejectedWith(Object.assign(new Error("x"), { code: "see https://push.example.com/secret" })),
      "unreachable",
      null,
      null,
    ],
  ] as const)("should classify %s", (_name, settled, outcome, statusCode, errorCode) => {
    expect(classifyProviderResult(settled as PromiseSettledResult<unknown>)).toEqual({ outcome, statusCode, errorCode })
  })
})

describe("providerFamily", () => {
  it.each([
    ["https://fcm.googleapis.com/fcm/send/abc", "fcm"],
    ["https://updates.push.services.mozilla.com/wpush/v2/abc", "mozilla"],
    ["https://web.push.apple.com/QGx", "apple"],
    ["https://wns2-db5p.notify.windows.com/w/?token=abc", "windows"],
    ["https://push.example.com/sub", "other"],
    ["https://evil-fcm.googleapis.com.example.com/x", "other"],
    ["not a url", "other"],
  ] as const)("should map %s to %s", (endpoint, family) => {
    expect(providerFamily(endpoint)).toBe(family)
  })
})
