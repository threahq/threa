import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { renderWorkspaceSettings } from "@/components/workspace-settings/test-harness"
import { SteeringWordsEditor } from "./steering-words-editor"

function Editor({ initial }: { initial: string[] }) {
  const [words, setWords] = useState(initial)
  return <SteeringWordsEditor setting="steering-words" words={words} ready busy={false} canEdit onChange={setWords} />
}

describe("SteeringWordsEditor", () => {
  it("moves focus to the next word after a removal, else the previous, else the add field", async () => {
    const user = userEvent.setup()
    renderWorkspaceSettings(<Editor initial={["Langfuse", "Postgres", "Railway"]} />, {
      permissions: null,
      route: "/?settings=voice",
    })
    const focusedName = () => document.activeElement?.getAttribute("aria-label")

    await user.click(screen.getByRole("button", { name: "Remove Postgres" }))
    const afterMiddle = focusedName()
    await user.click(screen.getByRole("button", { name: "Remove Railway" }))
    const afterLast = focusedName()
    await user.click(screen.getByRole("button", { name: "Remove Langfuse" }))

    expect({ afterMiddle, afterLast, afterAll: focusedName() }).toEqual({
      afterMiddle: "Remove Railway",
      afterLast: "Remove Langfuse",
      afterAll: "Add a dictation steering word",
    })
  })

  it("keeps the built-in words out of the list, saying they're always included, so an empty list reads as empty", () => {
    const { unmount } = renderWorkspaceSettings(<Editor initial={[]} />, {
      permissions: null,
      route: "/?settings=voice",
    })
    const empty = screen.getByText(/always included/).textContent
    unmount()
    renderWorkspaceSettings(<Editor initial={["Langfuse"]} />, { permissions: null, route: "/?settings=voice" })

    expect({
      empty,
      withWords: screen.getByText(/always included/).textContent,
      chips: screen.queryAllByText(/^(Threa|Ariadne)$/).length,
    }).toEqual({
      empty: "No words yet. Threa and Ariadne are always included.",
      withWords: "Threa and Ariadne are always included.",
      chips: 0,
    })
  })
})
