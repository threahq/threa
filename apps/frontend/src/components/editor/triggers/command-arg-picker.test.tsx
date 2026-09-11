import { createRef } from "react"
import { describe, it, expect, afterEach } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
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

  it("should complete on Tab even with no row armed, rather than let the editor indent", () => {
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
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true })
    const consumed = ref.current!.onKeyDown(tab)
    expect({ consumed, prevented: tab.defaultPrevented, picked }).toEqual({
      consumed: true,
      prevented: true,
      picked: ["claude"],
    })
  })

  it("should leave focus in the editor on mousedown, so the click still reaches the option", () => {
    const picked: string[] = []
    render(
      <CommandArgPicker
        items={[{ value: "pi", label: "Pi" }]}
        clientRect={() => new DOMRect()}
        command={(item) => picked.push(item.value)}
      />
    )
    // The picker's session is focus-gated on the editor: an option that took
    // focus on mousedown would unmount the list before the click landed.
    const option = screen.getByRole("option")
    const focusMoved = fireEvent.mouseDown(option)
    fireEvent.click(option)
    expect({ focusMoved, picked }).toEqual({ focusMoved: false, picked: ["pi"] })
  })
})
