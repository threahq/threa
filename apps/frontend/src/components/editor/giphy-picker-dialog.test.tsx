import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import type { GiphyGif } from "@threa/types"
import { giphyApi } from "@/api"
import { GiphyPickerDialog } from "./giphy-picker-dialog"

const GIF: GiphyGif = {
  id: "abc123",
  title: "happy cat",
  previewUrl: "https://media.giphy.com/abc123.gif",
  width: 200,
  height: 150,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GiphyPickerDialog", () => {
  it("loads trending GIFs on open and attaches the chosen one", async () => {
    const trending = vi.spyOn(giphyApi, "trending").mockResolvedValue({ items: [GIF], nextOffset: null })
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()

    render(<GiphyPickerDialog open workspaceId="ws_1" onSelect={onSelect} onOpenChange={onOpenChange} />)

    const tile = await screen.findByRole("button", { name: "happy cat" })
    expect(trending).toHaveBeenCalledWith("ws_1", expect.objectContaining({ offset: 0 }))

    fireEvent.click(tile)
    expect(onSelect).toHaveBeenCalledWith(GIF)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("searches Giphy as the user types", async () => {
    vi.spyOn(giphyApi, "trending").mockResolvedValue({ items: [], nextOffset: null })
    const search = vi.spyOn(giphyApi, "search").mockResolvedValue({ items: [GIF], nextOffset: null })

    render(<GiphyPickerDialog open workspaceId="ws_1" onSelect={vi.fn()} onOpenChange={vi.fn()} />)

    fireEvent.change(screen.getByLabelText("Search GIPHY"), { target: { value: "cat" } })

    await waitFor(() => expect(search).toHaveBeenCalledWith("ws_1", "cat", expect.objectContaining({ offset: 0 })))
    expect(await screen.findByRole("button", { name: "happy cat" })).toBeTruthy()
  })
})
