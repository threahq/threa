import { describe, expect, it } from "bun:test"
import { buildEditedSourcePrompt } from "./invocation-route-resolver"

describe("buildEditedSourcePrompt", () => {
  it("keeps the current wording first and block-quotes every line of the answered wording", () => {
    expect(
      buildEditedSourcePrompt("book me a flight to Oslo", {
        previousMarkdown: "book me a flight to Bergen\nwindow seat",
        previousRevision: 2,
        currentRevision: 3,
      })
    ).toBe(
      [
        "book me a flight to Oslo",
        "",
        "---",
        "",
        "You already answered this message. It was edited afterwards (revision 2 to 3). What it said when you answered:",
        "",
        "> book me a flight to Bergen",
        "> window seat",
        "",
        "The wording above the separator is current and is what the author now means; the quoted wording is obsolete.",
        "Work out what the edit changes. If your previous answer no longer holds, answer the edited request directly. If it still holds, say so in a line instead of repeating it. Do not narrate the edit itself.",
      ].join("\n")
    )
  })
})
