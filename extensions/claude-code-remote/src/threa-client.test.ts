import { describe, expect, test } from "bun:test"
import { buildBotSocketUrl, parseWsHint } from "./threa-client"

describe("parseWsHint", () => {
  test("accepts a wsUrl and defaults the socket.io path + /bot namespace", () => {
    expect(parseWsHint({ url: "wss://eu.threa.io" })).toEqual({
      url: "wss://eu.threa.io",
      path: "/socket.io/",
      namespace: "/bot",
    })
  })

  test("preserves explicit path and namespace", () => {
    expect(parseWsHint({ url: "wss://eu.threa.io", path: "/p/", namespace: "/bot" })).toEqual({
      url: "wss://eu.threa.io",
      path: "/p/",
      namespace: "/bot",
    })
  })

  test("rejects payloads without a usable url", () => {
    expect(parseWsHint({ path: "/socket.io/" })).toBeUndefined()
    expect(parseWsHint({ url: "   " })).toBeUndefined()
    expect(parseWsHint(null)).toBeUndefined()
    expect(parseWsHint("wss://eu.threa.io")).toBeUndefined()
  })
})

describe("buildBotSocketUrl", () => {
  test("appends the namespace to the pathname", () => {
    expect(buildBotSocketUrl({ url: "https://eu.threa.io", path: "/socket.io/", namespace: "/bot" })).toBe(
      "https://eu.threa.io/bot"
    )
  })

  test("does not double the slash on a trailing-slash url", () => {
    expect(buildBotSocketUrl({ url: "https://eu.threa.io/", path: "/socket.io/", namespace: "/bot" })).toBe(
      "https://eu.threa.io/bot"
    )
  })

  test("keeps a query string while appending the namespace (staging routes ?region=)", () => {
    expect(
      buildBotSocketUrl({ url: "https://ws-staging.threa.io?region=staging", path: "/socket.io/", namespace: "/bot" })
    ).toBe("https://ws-staging.threa.io/bot?region=staging")
  })
})
