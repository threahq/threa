import { describe, it, expect } from "vitest"
import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom"
import { PanelProvider, usePanel } from "./panel-context"

/**
 * On mobile an open panel takes over the whole screen, so the platform back
 * gesture has to close it rather than leave the page. These exercise the real
 * router: `router.navigate(-1)` is the back gesture, and the assertions are on
 * where it lands.
 */

function Probe() {
  const { openPanel, closePanel } = usePanel()
  const location = useLocation()
  return (
    <div>
      <span data-testid="loc">{`${location.pathname}${location.search}`}</span>
      <button onClick={() => openPanel("conv:a")}>open a</button>
      <button onClick={() => openPanel("conv:b", { replace: true })}>supersede with b</button>
      <button onClick={closePanel}>close</button>
    </div>
  )
}

function mount(initialEntries: string[]) {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <PanelProvider>
            <Probe />
          </PanelProvider>
        ),
      },
    ],
    { initialEntries, initialIndex: initialEntries.length - 1 }
  )
  render(<RouterProvider router={router} />)
  const back = async () => {
    await act(async () => {
      await router.navigate(-1)
    })
  }
  return { back, loc: () => screen.getByTestId("loc").textContent }
}

const BOARD = "/board?lens=all"
const STREAM = "/s/stream_1"

describe("panel history", () => {
  it("pushes an entry, so back closes the panel instead of leaving the page", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("button", { name: "open a" }))
    expect(loc()).toBe("/board?lens=all&panel=conv%3Aa")

    await back()
    expect(loc()).toBe(BOARD)
  })

  it("pops the entry it pushed when closed in the UI, leaving no duplicate", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("button", { name: "open a" }))
    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(BOARD)

    // The board is reached in ONE back press, not two — closing consumed the
    // entry opening added rather than stacking a second board entry on top.
    await back()
    expect(loc()).toBe(STREAM)
  })

  it("closes a deep-linked panel without popping — that entry isn't ours to consume", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, `${BOARD}&panel=conv%3Aa`])

    await user.click(screen.getByRole("button", { name: "close" }))
    // Popping here would have left the app entirely.
    expect(loc()).toBe(BOARD)

    await back()
    expect(loc()).toBe(STREAM)
  })

  it("a superseding open replaces, so back skips the panel it replaced", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("button", { name: "open a" }))
    await user.click(screen.getByRole("button", { name: "supersede with b" }))
    expect(loc()).toBe("/board?lens=all&panel=conv%3Ab")

    // A promoted draft's old id no longer resolves — back must reach the board.
    await back()
    expect(loc()).toBe(BOARD)
  })

  it("closes a superseding panel by popping — the replaced entry was still ours", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([STREAM, BOARD])

    await user.click(screen.getByRole("button", { name: "open a" }))
    await user.click(screen.getByRole("button", { name: "supersede with b" }))
    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(BOARD)

    await back()
    expect(loc()).toBe(STREAM)
  })
})
