import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FilterSelect } from "./filter-select"
import { mockUsersList } from "@/test/fixtures/users"
import { mockStreamsList } from "@/test/fixtures"

const noop = () => {}

function renderUserFilter() {
  return render(
    <FilterSelect type="from" users={mockUsersList} streams={[]} streamTypes={[]} onSelect={vi.fn()} onCancel={noop} />
  )
}

describe("FilterSelect", () => {
  it("keeps matching users listed once a query is typed", async () => {
    const user = userEvent.setup()
    renderUserFilter()
    const target = mockUsersList[0]

    await user.type(screen.getByPlaceholderText("Search users..."), target.name.slice(0, 3))

    // The rows are ranked by this component and rendered by cmdk. cmdk filters
    // again by each item's `value`, which here is a ULID no query can match —
    // so a second ranker silently empties a list its owner had already filtered.
    expect(screen.getByText(target.name)).toBeInTheDocument()
    expect(screen.queryByText("No users found.")).not.toBeInTheDocument()
  })

  it("keeps matching streams listed once a query is typed", async () => {
    const user = userEvent.setup()
    const target = mockStreamsList.find((stream) => stream.slug)
    if (!target?.slug) throw new Error("fixture needs a stream with a slug")
    render(
      <FilterSelect
        type="in"
        users={[]}
        streams={mockStreamsList}
        streamTypes={[]}
        onSelect={vi.fn()}
        onCancel={noop}
      />
    )

    await user.type(screen.getByPlaceholderText("Search streams..."), target.slug.slice(0, 3))

    expect(screen.queryByText("No streams found.")).not.toBeInTheDocument()
  })
})
