import { describe, expect, it } from "bun:test"
import { reactionTurnPrompt } from "./reaction-turn"

const added = { action: "added", emoji: ":white_check_mark:", reactorId: "usr_1", reactorName: "Kris" } as const
const claim = (events: unknown[], promptMarkdown = "hi") => ({
  metadata: { reaction: { events } },
  sourceMessageId: "msg_1",
  promptMarkdown,
})
const FOOTER =
  "This is a reaction, not a message. Reply only if it calls for one. To stay silent, reply exactly THREA_NO_RESPONSE."

describe("reactionTurnPrompt", () => {
  it("renders an add with a blockquoted message and the silent marker, shortcode as given", () => {
    expect(reactionTurnPrompt(claim([added], "Done\n\nall green"))).toBe(
      [
        "Kris reacted :white_check_mark: to your message msg_1.",
        "",
        "Your message:",
        "> Done",
        ">",
        "> all green",
        "",
        FOOTER,
      ].join("\n")
    )
  })

  it("lists several events, names unknown reactors Someone, and phrases removals", () => {
    const prompt = reactionTurnPrompt(
      claim([added, { action: "removed", emoji: "👀", reactorId: "usr_2", reactorName: null }])
    )
    expect(prompt).toContain("Kris reacted :white_check_mark: to your message msg_1.")
    expect(prompt).toContain("Someone removed their 👀 reaction from your message msg_1.")
  })

  it("truncates a long quote and marks it", () => {
    const prompt = reactionTurnPrompt(claim([added], "a".repeat(2000)))
    expect(prompt).toContain(`> ${"a".repeat(500)}…`)
    expect(prompt).not.toContain("a".repeat(501))
  })

  it.each([
    undefined,
    null,
    {},
    { reaction: {} },
    { reaction: { events: [] } },
    { reaction: { events: [{ ...added, action: "toggled" }] } },
    { reaction: { events: [{ ...added, reactorName: 3 }] } },
    { reaction: { events: [added, { emoji: "x" }] } },
  ])("returns null for malformed metadata %j", (metadata) => {
    expect(reactionTurnPrompt({ metadata, sourceMessageId: "msg_1", promptMarkdown: "hi" })).toBeNull()
  })
})
