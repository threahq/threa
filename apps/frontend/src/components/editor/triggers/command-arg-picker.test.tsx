import { describe, it, expect, afterEach } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { CommandArgPicker } from "./command-arg-picker"

afterEach(cleanup)

describe("CommandArgPicker", () => {
  it("should show the description under the label when the runtime sent one, else the value", () => {
    render(
      <CommandArgPicker
        items={[
          { value: "claude", label: "Claude Code", description: "/home/kris/.npm-global/bin/claude" },
          { value: "openai/gpt-5.6", label: "GPT-5.6" },
          { value: "opus", description: "Recommended" },
        ]}
        clientRect={() => new DOMRect()}
        command={() => {}}
      />
    )
    const rows = screen.getAllByRole("option").map((row) => row.textContent)
    expect(rows).toEqual(["Claude Code/home/kris/.npm-global/bin/claude", "GPT-5.6openai/gpt-5.6", "opusRecommended"])
  })
})
