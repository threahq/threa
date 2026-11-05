import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SearchableSelect } from "./searchable-select"

const ZONES = ["Europe/Stockholm", "Asia/Tokyo"]

describe("SearchableSelect", () => {
  it("points its combobox at the listbox it opens", async () => {
    const user = userEvent.setup()
    render(
      <>
        <span id="zone-label">Time zone</span>
        <SearchableSelect
          items={ZONES}
          value={ZONES[0]!}
          onChange={() => {}}
          getKey={(zone) => zone}
          getKeywords={(zone) => [zone]}
          renderItem={(zone) => zone}
          aria-labelledby="zone-label"
        />
      </>
    )
    const combobox = screen.getByRole("combobox", { name: "Time zone" })
    const closed = combobox.getAttribute("aria-controls")
    await user.click(combobox)

    expect({
      closed,
      open: combobox.getAttribute("aria-controls"),
      haspopup: combobox.getAttribute("aria-haspopup"),
    }).toEqual({ closed: null, open: screen.getByRole("listbox").id, haspopup: "listbox" })
  })
})
