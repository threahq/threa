import { describe, it, expect, afterEach } from "vitest"
import { isIosWebKit } from "./platform"

const REAL = {
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  maxTouchPoints: navigator.maxTouchPoints,
}

function stubNavigator(values: { userAgent?: string; platform?: string; maxTouchPoints?: number }) {
  for (const [key, value] of Object.entries({ ...REAL, ...values })) {
    Object.defineProperty(navigator, key, { configurable: true, get: () => value })
  }
}

afterEach(() => stubNavigator(REAL))

describe("isIosWebKit", () => {
  it("matches an iPhone by user agent", () => {
    stubNavigator({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15" })
    expect(isIosWebKit()).toBe(true)
  })

  it("matches iPadOS, which reports a desktop platform and no iPad in the UA", () => {
    // Since iPadOS 13 Safari claims Macintosh; touch points are the only tell, and
    // this branch is why the probe cannot be a plain UA test.
    stubNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    })
    expect(isIosWebKit()).toBe(true)
  })

  it("does not match a real Mac, which reports the same platform with no touch", () => {
    stubNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150",
      platform: "MacIntel",
      maxTouchPoints: 0,
    })
    expect(isIosWebKit()).toBe(false)
  })

  it("does not match Android", () => {
    stubNavigator({
      userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/150",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    })
    expect(isIosWebKit()).toBe(false)
  })
})
