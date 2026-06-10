import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MessageSourceList } from "./message-sources"

const sources = [
  { title: "Tide Atlas", url: "https://tides.example/atlas", snippet: "the moon pulls the sea" },
  { type: "web", title: "Lunar Cycles", url: "https://moon.example/cycles" },
]

describe("MessageSourceList", () => {
  it("renders a collapsed source count that expands to linked citations", async () => {
    render(<MessageSourceList sources={sources} />)

    // Collapsed by default: the count chip shows, the citations don't.
    expect(screen.getByText("Sources")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    expect(screen.queryByText("Tide Atlas")).not.toBeInTheDocument()

    await userEvent.click(screen.getByText("Sources"))

    const atlas = screen.getByRole("link", { name: "Tide Atlas" })
    expect(atlas).toHaveAttribute("href", "https://tides.example/atlas")
    expect(atlas).toHaveAttribute("target", "_blank")
    expect(screen.getByRole("link", { name: "Lunar Cycles" })).toHaveAttribute("href", "https://moon.example/cycles")
    expect(screen.getByText("tides.example")).toBeInTheDocument()
    expect(screen.getByText("the moon pulls the sea")).toBeInTheDocument()
  })

  it("renders nothing for an empty source list", () => {
    const { container } = render(<MessageSourceList sources={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
