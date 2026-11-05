import { describe, expect, it } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { useCommittedText } from "./committed-field"
import { SaveIndicator } from "./setting-primitives"

/** A commit that stays in flight until the test settles it. */
function deferredCommits() {
  const calls: { value: string; resolve: () => void }[] = []
  const commit = (value: string) =>
    new Promise<void>((resolve) => {
      calls.push({ value, resolve })
    })
  return { calls, commit }
}

function Field({ commit }: { commit: (value: string) => Promise<void> }) {
  const [saved, setSaved] = useState("start")
  const field = useCommittedText<HTMLInputElement>({
    saved,
    commit: async (value) => {
      await commit(value)
      setSaved(value)
    },
  })
  return (
    <>
      <input
        aria-label="Name"
        ref={field.fieldRef}
        value={field.value}
        onChange={(event) => field.onChange(event.target.value)}
        onBlur={() => void field.save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void field.save()
        }}
      />
      <SaveIndicator state={field.state} />
    </>
  )
}

async function settle(call: { resolve: () => void } | undefined) {
  await act(async () => call?.resolve())
}

describe("useCommittedText", () => {
  it("commits what was typed during a save once that save lands, and only then says Saved", async () => {
    const user = userEvent.setup()
    const { calls, commit } = deferredCommits()
    render(<Field commit={commit} />)
    const input = screen.getByRole("textbox", { name: "Name" })

    await user.clear(input)
    await user.type(input, "Ada{Enter}")
    await user.type(input, " Lovelace")
    await user.tab()
    await settle(calls[0])

    expect({ commits: calls.map((call) => call.value), saved: screen.queryByText("Saved") }).toEqual({
      commits: ["Ada", "Ada Lovelace"],
      saved: null,
    })

    await settle(calls[1])

    expect({ value: input.getAttribute("value"), saved: screen.getByText("Saved") !== null }).toEqual({
      value: "Ada Lovelace",
      saved: true,
    })
  })

  it("never says Saved while a newer draft is still only typed", async () => {
    const user = userEvent.setup()
    const { calls, commit } = deferredCommits()
    render(<Field commit={commit} />)
    const input = screen.getByRole("textbox", { name: "Name" })

    await user.clear(input)
    await user.type(input, "Ada{Enter}")
    await user.type(input, "!")
    await settle(calls[0])

    expect({
      commits: calls.map((call) => call.value),
      value: input.getAttribute("value"),
      saved: screen.queryByText("Saved"),
    }).toEqual({ commits: ["Ada"], value: "Ada!", saved: null })
  })

  it("still commits the latest draft when the field closes mid-save", async () => {
    const user = userEvent.setup()
    const { calls, commit } = deferredCommits()
    const { unmount } = render(<Field commit={commit} />)
    const input = screen.getByRole("textbox", { name: "Name" })

    await user.clear(input)
    await user.type(input, "Ada{Enter}")
    await user.type(input, "!")
    unmount()
    await settle(calls[0])

    expect(calls.map((call) => call.value)).toEqual(["Ada", "Ada!"])
  })
})
