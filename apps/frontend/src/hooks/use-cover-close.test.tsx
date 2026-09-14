import { describe, it, expect } from "vitest"
import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  createMemoryRouter,
  Link,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
  type InitialEntry,
} from "react-router-dom"
import { useCoverClose } from "./use-cover-close"
import { PANEL_COVER, TRACE_COVER, type Cover } from "@/lib/covers"

const ELSEWHERE = "/elsewhere"
const ROOT = "/w/ws?panel=x"
const BARE = "/s/stream_1"
const PAGE = `${BARE}?panel=x`

/** A `?trace=` cover with its `?highlight=` companion, opened the ways covers
 *  open in the product: a push, a `<Link>`, a replace, or a launch rebuild. */
function Probe({ cover }: { cover: Cover }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [, setSearchParams] = useSearchParams()
  const close = useCoverClose(cover)
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
      <button
        onClick={() => {
          navigate(PAGE, { replace: true })
          navigate(`${PAGE}&trace=a&highlight=m-a`)
        }}
      >
        redirect then push a
      </button>
      <button onClick={close}>close</button>
      <button onClick={() => navigate(-1)}>back</button>
    </div>
  )
}

function mount(initialEntries: InitialEntry[], cover: Cover = TRACE_COVER) {
  const router = createMemoryRouter([{ path: "*", element: <Probe cover={cover} /> }], {
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

  it("claims a push batched into one commit with the redirect beneath it", async () => {
    // The workspace root redirects to its default stream with a replace, and a
    // cover opened in the same tick pushes on top of that; React commits both
    // at once, so the committed location never shows the entry beneath.
    const user = userEvent.setup()
    const { back, loc } = mount([ELSEWHERE, ROOT])
    await user.click(screen.getByRole("button", { name: "redirect then push a" }))
    expect(loc()).toBe(`${PAGE}&trace=a&highlight=m-a`)

    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(PAGE)
    await back()
    expect(loc()).toBe(ELSEWHERE)
  })

  it("pops a pushed entry under a plain <MemoryRouter>, fed by the committed location", async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={[ELSEWHERE, PAGE]} initialIndex={1}>
        <Routes>
          <Route path="*" element={<Probe cover={TRACE_COVER} />} />
        </Routes>
      </MemoryRouter>
    )
    const loc = () => screen.getByTestId("loc").textContent
    await user.click(screen.getByRole("button", { name: "push a" }))
    expect(loc()).toBe(`${PAGE}&trace=a&highlight=m-a`)

    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(PAGE)
    await user.click(screen.getByRole("button", { name: "back" }))
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

  it("honors the attestation on a hop it first sees by popping back onto it (a stacked cold launch)", async () => {
    // The rebuild commits its hops in one batch: the panel hop under the trace
    // hop is never observed as a PUSH, only as a POP once the trace is closed.
    const user = userEvent.setup()
    const { back, loc } = mount(
      [
        ELSEWHERE,
        BARE,
        { pathname: BARE, search: "?panel=x", state: { popsToClose: "panel" } },
        { pathname: BARE, search: "?panel=x&trace=t", state: { popsToClose: "trace" } },
      ],
      PANEL_COVER
    )
    await back()
    expect(loc()).toBe(PAGE)

    await user.click(screen.getByRole("button", { name: "close" }))
    expect(loc()).toBe(BARE)
    await back()
    expect(loc()).toBe(ELSEWHERE)
  })
})
