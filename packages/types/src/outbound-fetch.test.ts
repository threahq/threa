import { describe, expect, test } from "bun:test"
import {
  isRedditUrl,
  REDDIT_CRAWLER_USER_AGENT,
  resolveFetchUserAgent,
  THREA_BOT_CONTACT_URL,
  threaFetchUserAgent,
} from "./outbound-fetch"

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

describe("isRedditUrl", () => {
  test("matches reddit.com, its subdomains, and the redd.it shortener", () => {
    expect(isRedditUrl("https://www.reddit.com/r/ClaudeAI/comments/abc/title/")).toBe(true)
    expect(isRedditUrl("https://reddit.com/r/ClaudeAI")).toBe(true)
    expect(isRedditUrl("https://old.reddit.com/r/ClaudeAI")).toBe(true)
    expect(isRedditUrl("https://redd.it/abc123")).toBe(true)
  })

  test("does not match lookalike or unrelated hosts", () => {
    expect(isRedditUrl("https://notreddit.com/r/ClaudeAI")).toBe(false)
    expect(isRedditUrl("https://reddit.com.evil.example/r/x")).toBe(false)
    expect(isRedditUrl("https://example.com")).toBe(false)
    expect(isRedditUrl("not a url")).toBe(false)
  })
})

describe("resolveFetchUserAgent", () => {
  test("routes Reddit hosts through the recognized crawler token", () => {
    expect(resolveFetchUserAgent("Link Preview", "https://www.reddit.com/r/ClaudeAI/comments/abc/")).toBe(
      REDDIT_CRAWLER_USER_AGENT
    )
    expect(resolveFetchUserAgent("Agent Reader", "https://redd.it/abc123")).toBe(REDDIT_CRAWLER_USER_AGENT)
  })

  test("uses the polite component-tagged UA for everything else", () => {
    expect(resolveFetchUserAgent("Agent Reader", "https://example.com/post")).toBe(threaFetchUserAgent("Agent Reader"))
  })
})
