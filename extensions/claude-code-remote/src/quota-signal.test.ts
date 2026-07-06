import { describe, expect, it } from "bun:test"
import { classifyApiErrorText, parseResetTime } from "./quota-signal"

// 2026-07-05 12:00:00 UTC — 14:00 in Europe/Stockholm (CEST, UTC+2).
const NOW = Date.UTC(2026, 6, 5, 12, 0, 0)

describe("classifyApiErrorText", () => {
  it("parses the real session-limit shape into a scheduled reset", () => {
    const signal = classifyApiErrorText("You've hit your session limit · resets 10:20pm (Europe/Stockholm)", NOW)
    expect(signal.kind).toBe("quota-reset")
    // 22:20 Stockholm on the same day = 20:20 UTC.
    expect(signal.resetAt).toBe(Date.UTC(2026, 6, 5, 20, 20, 0))
  })

  it("rolls a reset time already past today over to tomorrow", () => {
    const signal = classifyApiErrorText("You've hit your session limit · resets 9:00am (Europe/Stockholm)", NOW)
    expect(signal.kind).toBe("quota-reset")
    // 09:00 Stockholm has passed at 14:00 local — next occurrence is tomorrow, 07:00 UTC.
    expect(signal.resetAt).toBe(Date.UTC(2026, 6, 6, 7, 0, 0))
  })

  it("resolves a weekday-qualified reset to that weekday", () => {
    const signal = classifyApiErrorText("You've hit your weekly limit · resets Tuesday 3:00pm (Europe/Stockholm)", NOW)
    expect(signal.kind).toBe("quota-reset")
    // 2026-07-05 is a Sunday; next Tuesday is 07-07. 15:00 Stockholm = 13:00 UTC.
    expect(signal.resetAt).toBe(Date.UTC(2026, 6, 7, 13, 0, 0))
  })

  it("classifies the monthly spend limit as quota without a reset", () => {
    const signal = classifyApiErrorText(
      "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage",
      NOW
    )
    expect(signal).toEqual({ kind: "quota-no-reset", summary: expect.stringContaining("monthly spend limit") })
  })

  it("classifies server-side throttling and outages as transient", () => {
    const transients = [
      "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
      "API Error: Overloaded",
      "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.",
      "API Error: Unable to connect to API (ConnectionRefused)",
      "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` …",
    ]
    for (const text of transients) {
      expect(classifyApiErrorText(text, NOW).kind).toBe("transient")
    }
  })

  it("leaves non-retryable errors alone", () => {
    const others = [
      "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy …",
      "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.",
      "Prompt is too long",
      "The model's tool call could not be parsed (retry also failed).",
    ]
    for (const text of others) {
      expect(classifyApiErrorText(text, NOW).kind).toBe("other")
    }
  })

  it("falls back to quota-no-reset when the reset timezone is unparseable", () => {
    const signal = classifyApiErrorText("You've hit your session limit · resets 10:20pm (Nowhere/Land)", NOW)
    expect(signal.kind).toBe("quota-no-reset")
  })
})

describe("parseResetTime", () => {
  it("returns the imminent slot when the reset just passed (quota is already back)", () => {
    // 22:21 Stockholm — one minute after the printed reset.
    const justAfter = Date.UTC(2026, 6, 5, 20, 21, 0)
    expect(parseResetTime("resets 10:20pm (Europe/Stockholm)", justAfter)).toBe(Date.UTC(2026, 6, 5, 20, 20, 0))
  })

  it("handles minute-less times", () => {
    expect(parseResetTime("resets 11pm (Europe/Stockholm)", NOW)).toBe(Date.UTC(2026, 6, 5, 21, 0, 0))
  })

  it("does not skip the 23h spring-forward day", () => {
    // Sat 2026-03-28 23:00 CET (22:00 UTC); Stockholm springs forward on Sun 03-29.
    // A fixed 24h-ms day walk lands past the whole 23h Sunday and resolves a
    // day (or, weekday-qualified, a week) late.
    const beforeTransition = Date.UTC(2026, 2, 28, 22, 0, 0)
    // 05:00 CEST on 03-29 = 03:00 UTC.
    const expected = Date.UTC(2026, 2, 29, 3, 0, 0)
    expect(parseResetTime("resets 5:00am (Europe/Stockholm)", beforeTransition)).toBe(expected)
    expect(parseResetTime("resets Sunday 5:00am (Europe/Stockholm)", beforeTransition)).toBe(expected)
  })

  it("returns undefined for text without a reset clause", () => {
    expect(parseResetTime("ask your admin to raise it", NOW)).toBeUndefined()
  })
})
