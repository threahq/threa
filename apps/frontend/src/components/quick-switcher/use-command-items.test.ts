import { describe, it, expect } from "vitest"
import { FileText } from "lucide-react"
import { commands, type Command } from "./commands"
import { rankCommands } from "./use-command-items"

function makeCommand(overrides: Partial<Command> & Pick<Command, "id" | "label">): Command {
  return { icon: FileText, action: () => {}, ...overrides }
}

describe("rankCommands", () => {
  it("returns all commands in curated order for an empty query", () => {
    expect(rankCommands(commands, "")).toEqual(commands)
  })

  it("ranks a label match above an earlier-defined keyword-only match", () => {
    // "Add To-do" matches "saved" only via its hidden alias; "View Saved"
    // matches on its visible label. Label must win despite definition order.
    const todo = makeCommand({ id: "add-todo", label: "Add To-do", keywords: ["saved", "task"] })
    const saved = makeCommand({ id: "view-saved", label: "View Saved", keywords: ["bookmark"] })
    const ranked = rankCommands([todo, saved], "saved")
    expect(ranked.map((c) => c.id)).toEqual(["view-saved", "add-todo"])
  })

  it("ranks real palette commands by where the match landed", () => {
    // "New Scratchpad" carries the keyword "note" and is defined before
    // "New Quick Note", whose visible label matches.
    const ranked = rankCommands(commands, "note")
    const quickNoteIndex = ranked.findIndex((c) => c.id === "new-quick-note")
    const scratchpadIndex = ranked.findIndex((c) => c.id === "new-scratchpad")
    expect(quickNoteIndex).toBeGreaterThanOrEqual(0)
    expect(scratchpadIndex).toBeGreaterThanOrEqual(0)
    expect(quickNoteIndex).toBeLessThan(scratchpadIndex)
  })

  it("still matches on hidden keywords and ids", () => {
    const ranked = rankCommands(commands, "bookmark")
    expect(ranked.map((c) => c.id)).toContain("view-saved")
  })

  it("drops non-matching commands", () => {
    const ranked = rankCommands(commands, "zzz-no-such-command")
    expect(ranked).toEqual([])
  })
})
