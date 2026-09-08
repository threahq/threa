import { createRef } from "react"
import { describe, it, expect, afterEach } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { CommandArgPicker, type CommandArgPickerRef } from "./command-arg-picker"

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

  it("should arm no row and let Enter through when selection is deferred, until an arrow key arms one", () => {
    const ref = createRef<CommandArgPickerRef>()
    const picked: string[] = []
    render(
      <CommandArgPicker
        ref={ref}
        items={[
          { value: "claude", label: "Claude Code" },
          { value: "pi", label: "Pi" },
        ]}
        clientRect={() => new DOMRect()}
        command={(item) => picked.push(item.value)}
        deferSelection
      />
    )
    const armed = () => screen.getAllByRole("option").map((row) => row.getAttribute("aria-selected"))
    const enter = new KeyboardEvent("keydown", { key: "Enter" })
    const before = { armed: armed(), consumed: ref.current!.onKeyDown(enter) }
    act(() => {
      ref.current!.onKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }))
    })
    const after = { armed: armed(), consumed: ref.current!.onKeyDown(enter), picked }
    expect({ before, after }).toEqual({
      before: { armed: ["false", "false"], consumed: false },
      after: { armed: ["true", "false"], consumed: true, picked: ["claude"] },
    })
  })
})
