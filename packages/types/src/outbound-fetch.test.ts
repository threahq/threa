import { describe, expect, test } from "bun:test"
import { THREA_BOT_CONTACT_URL, threaFetchUserAgent } from "./outbound-fetch"

describe("threaFetchUserAgent", () => {
  // The `+`-prefixed contact URL is what gets Amazon-class bot gates to serve real HTML instead of
  // a captcha page. If a refactor ever drops it, previews silently go blank — so guard the format.
  test("always carries the +-prefixed contact URL", () => {
    expect(threaFetchUserAgent("Link Preview")).toMatch(/\+https?:\/\//)
    expect(threaFetchUserAgent("Link Preview")).toContain(`+${THREA_BOT_CONTACT_URL}`)
  })

  test("tags the User-Agent with the calling component", () => {
    expect(threaFetchUserAgent("Agent Reader")).toBe("Threa/1.0 (Agent Reader; +https://threa.io/bot)")
  })
})
