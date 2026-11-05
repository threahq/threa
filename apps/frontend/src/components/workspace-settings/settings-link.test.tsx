import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useNavigationType } from "react-router-dom"
import { SettingsLink } from "./settings-link"

function Landed() {
  return <p>Landed by {useNavigationType()}</p>
}

function mount(replace?: boolean) {
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <Routes>
        <Route
          path="/start"
          element={
            <SettingsLink to="/elsewhere" replace={replace}>
              Go
            </SettingsLink>
          }
        />
        <Route path="/elsewhere" element={<Landed />} />
      </Routes>
    </MemoryRouter>
  )
}

describe("SettingsLink", () => {
  it.each([
    [undefined, "REPLACE"],
    [false, "PUSH"],
  ])("with replace=%s navigates by %s", async (replace, expected) => {
    const user = userEvent.setup()
    mount(replace)
    await user.click(screen.getByRole("link", { name: "Go" }))

    expect(screen.getByText(/^Landed by/).textContent).toBe(`Landed by ${expected}`)
  })
})
