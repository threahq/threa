import { describe, it, expect } from "vitest"
import { actorRowTheme, ACTOR_ROW_THEME } from "./actor-row-theme"

describe("actorRowTheme", () => {
  it("gives each actor type its accent + name color, and a BOT badge for bots", () => {
    expect(actorRowTheme("user").rowAccent).toBe("")
    expect(actorRowTheme("user").nameClassName).toBe("")
    expect(actorRowTheme("persona").rowAccent).not.toBe("")
    expect(actorRowTheme("persona").nameClassName).toContain("text-primary")
    expect(actorRowTheme("bot").rowAccent).not.toBe("")
    expect(actorRowTheme("bot").badge).toBeTruthy()
    expect(actorRowTheme("system").rowAccent).not.toBe("")
  })

  it("defaults a null/undefined actor type to the plain user treatment", () => {
    expect(actorRowTheme(null)).toBe(ACTOR_ROW_THEME.user)
    expect(actorRowTheme(undefined)).toBe(ACTOR_ROW_THEME.user)
  })
})
