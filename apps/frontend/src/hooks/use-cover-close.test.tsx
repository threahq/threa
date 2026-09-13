import { describe, it, expect } from "vitest"
import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, Link, RouterProvider, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { useCoverClose } from "./use-cover-close"
import { TRACE_COVER } from "@/lib/covers"

const ELSEWHERE = "/elsewhere"
const PAGE = "/s/stream_1?panel=x"

/** A `?trace=` cover with its `?highlight=` companion, opened the ways covers
 *  open in the product: a push, a `<Link>`, a replace, or a launch rebuild. */
function Probe() {
  const location = useLocation()
  const navigate = useNavigate()
  const [, setSearchParams] = useSearchParams()
  const close = useCoverClose(TRACE_COVER)
  const set = (trace: string, replace: boolean) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set("trace", trace)
        next.set("highlight", `m-${trace}`)
        return next
      },
      { replace }
    )
  return (
    <div>
      <span data-testid="loc">{`${location.pathname}${location.search}`}</span>
      <button onClick={() => set("a", false)}>push a</button>
      <button onClick={() => set("b", true)}>replace with b</button>
      <Link to={`${PAGE}&trace=c&highlight=m-c`}>link to c</Link>
      <button onClick={() => navigate(`${PAGE}&trace=d`, { state: { popsToClose: "trace" } })}>rebuild d</button>
      <button onClick={() => navigate(`${PAGE}&trace=e`, { state: { popsToClose: "panel" } })}>
        rebuild e for panel
      </button>
      <button onClick={close}>close</button>
    </div>
  )
}

function mount(initialEntries: string[]) {
  const router = createMemoryRouter([{ path: "*", element: <Probe /> }], {
    initialEntries,
    initialIndex: initialEntries.length - 1,
  })
  render(<RouterProvider router={router} />)
  const back = async () => {
    await act(async () => {
      await router.navigate(-1)
    })
  }
  return { back, loc: () => screen.getByTestId("loc").textContent }
}

describe("useCoverClose", () => {
  it("pops the entry a push added, clearing the companion param, leaving no duplicate", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([ELSEWHERE, PAGE])
    await user.click(screen.getByRole("button", { name: "push a" }))
    expect(loc()).toBe(`${PAGE}&trace=a&highlight=m-a`)

    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(PAGE)
    await back()
    expect(loc()).toBe(ELSEWHERE)
  })

  it("treats a <Link> open the same as a push", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([ELSEWHERE, PAGE])
    await user.click(screen.getByRole("link", { name: "link to c" }))
    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(PAGE)
    await back()
    expect(loc()).toBe(ELSEWHERE)
  })

  it("carries the claim across a replace on top", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([ELSEWHERE, PAGE])
    await user.click(screen.getByRole("button", { name: "push a" }))
    await user.click(screen.getByRole("button", { name: "replace with b" }))
    expect(loc()).toBe(`${PAGE}&trace=b&highlight=m-b`)

    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(PAGE)
    await back()
    expect(loc()).toBe(ELSEWHERE)
  })

  it("rewrites in place when the cover was the first thing this context saw (deep link, reload)", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([ELSEWHERE, `${PAGE}&trace=z&highlight=m-z`])
    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(PAGE)
    await back()
    expect(loc()).toBe(ELSEWHERE)
  })

  it("rewrites in place when the entry beneath still carries the cover", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([ELSEWHERE, PAGE])
    await user.click(screen.getByRole("button", { name: "push a" }))
    await user.click(screen.getByRole("link", { name: "link to c" }))
    expect(loc()).toBe(`${PAGE}&trace=c&highlight=m-c`)

    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(PAGE)
    // Back still steps through the earlier instance.
    await back()
    expect(loc()).toBe(`${PAGE}&trace=a&highlight=m-a`)
  })

  it("trusts a launch-rebuild push that attests this cover, and only this cover", async () => {
    const user = userEvent.setup()
    const { back, loc } = mount([ELSEWHERE, PAGE, `${PAGE}&trace=a`])
    await user.click(screen.getByRole("button", { name: "rebuild d" }))
    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(`${PAGE}&trace=a`)

    await user.click(screen.getByRole("button", { name: "rebuild e for panel" }))
    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(PAGE)
    await back()
    expect(loc()).toBe(`${PAGE}&trace=a`)
  })
})
