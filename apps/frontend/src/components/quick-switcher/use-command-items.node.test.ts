import { describe, it, expect } from "vitest"
import { FileText } from "lucide-react"
import { commands, type Command } from "./commands"
import { rankGroups } from "./use-command-items"
import { draftStreamCommands } from "./stream-commands"

function makeCommand(overrides: Partial<Command> & Pick<Command, "id" | "label">): Command {
  return { icon: FileText, action: () => {}, ...overrides }
}

/** One group through the production path, which is the only way the palette ranks. */
const rankCommands = (candidates: Command[], query: string) => rankGroups(query, [candidates])[0]

describe("ranking one group", () => {
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

  it("surfaces the New Post command for authoring keywords", () => {
    for (const q of ["post", "compose", "write"]) {
      expect(rankCommands(commands, q).map((c) => c.id)).toContain("new-post")
    }
  })
})

describe("rankGroups", () => {
  it("drops guessed matches from every group once any group holds a real one", () => {
    // The palette renders the contextual group first and fires its first row
    // on Enter. On a draft scratchpad, "drafts" is one edit from the keyword
    // of "Delete this draft" — a guess that must not outrank the exact
    // "View Drafts" below it, or Enter deletes the draft.
    const [contextual, global] = rankGroups("drafts", [draftStreamCommands, commands])
    expect(contextual).toEqual([])
    expect(global[0]?.id).toBe("view-drafts")
  })

  it("keeps guessed matches when no group holds a real one", () => {
    const typo = makeCommand({ id: "view-drafts", label: "View Drafts", keywords: ["draft"] })
    const [only] = rankGroups("drfats", [[typo]])
    expect(only.map((c) => c.id)).toEqual(["view-drafts"])
  })
})
