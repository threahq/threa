import { createRef, useState, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DropdownMenuContent, DropdownMenuItem } from "./dropdown-menu"
import { HoverCardContent } from "./hover-card"
import { LazyDropdownMenu, LazyHoverCard, LazyPopover, LazyTooltip } from "./lazy-overlay"
import { PopoverContent } from "./popover"
import { TooltipContent, TooltipProvider } from "./tooltip"

const nativeMatches = Element.prototype.matches

/** jsdom never matches `:hover`; this stands in for the browser hit-testing the pointer onto the trigger. */
function pointerRestsOnTrigger() {
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    return selector === ":hover" || nativeMatches.call(this, selector)
  })
}

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
}

afterEach(() => {
  vi.restoreAllMocks()
})

function renderWithProvider(ui: ReactNode) {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)
}

function Menu() {
  const [open, setOpen] = useState(false)
  return (
    <LazyDropdownMenu open={open} onOpenChange={setOpen} trigger={<button type="button">Actions</button>}>
      <DropdownMenuContent>
        <DropdownMenuItem>Edit</DropdownMenuItem>
        <DropdownMenuItem>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </LazyDropdownMenu>
  )
}

function DatePopover() {
  const [open, setOpen] = useState(false)
  return (
    <LazyPopover open={open} onOpenChange={setOpen} trigger={<button type="button">Jump</button>}>
      <PopoverContent>Pick a date</PopoverContent>
    </LazyPopover>
  )
}

describe("LazyTooltip", () => {
  function renderTooltip({
    onClick = () => {},
    onAncestorPointerEnter = () => {},
    ref,
  }: {
    onClick?: () => void
    onAncestorPointerEnter?: () => void
    ref?: React.Ref<HTMLButtonElement>
  } = {}) {
    renderWithProvider(
      <div onPointerEnter={onAncestorPointerEnter}>
        <LazyTooltip
          trigger={
            <button type="button" ref={ref} onClick={onClick}>
              Reply
            </button>
          }
        >
          <TooltipContent>Reply in thread</TooltipContent>
        </LazyTooltip>
      </div>
    )
    return screen.getByRole("button", { name: "Reply" })
  }

  it("mounts only the bare trigger while closed", () => {
    const trigger = renderTooltip()
    expect(trigger).not.toHaveAttribute("data-state")
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  it("opens on the first hover, entering ancestors only once", async () => {
    const user = userEvent.setup()
    const onAncestorPointerEnter = vi.fn()
    pointerRestsOnTrigger()
    renderTooltip({ onAncestorPointerEnter })
    await user.hover(screen.getByRole("button", { name: "Reply" }))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Reply in thread")
    expect(onAncestorPointerEnter).toHaveBeenCalledTimes(1)
  })

  it("arms without opening when the pointer has left before the swapped-in trigger is hovered", async () => {
    const user = userEvent.setup()
    renderTooltip()
    await user.hover(screen.getByRole("button", { name: "Reply" }))
    await settle()
    expect(screen.getByRole("button", { name: "Reply" })).toHaveAttribute("data-state", "closed")
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  it("does not arm on a touch tap or on focus from a mouse press", async () => {
    const user = userEvent.setup()
    renderTooltip()
    const trigger = screen.getByRole("button", { name: "Reply" })
    await user.pointer({ keys: "[TouchA]", target: trigger })
    expect(trigger).toHaveFocus()
    act(() => trigger.blur())

    fireEvent.pointerDown(trigger, { pointerType: "mouse" })
    fireEvent.mouseDown(trigger)
    act(() => trigger.focus())

    expect({ connected: trigger.isConnected, state: trigger.getAttribute("data-state") }).toEqual({
      connected: true,
      state: null,
    })
  })

  it("keeps keyboard focus on the trigger it swaps in and shows the tooltip", async () => {
    const user = userEvent.setup()
    const ref = createRef<HTMLButtonElement>()
    renderTooltip({ ref })
    await user.tab()
    const trigger = screen.getByRole("button", { name: "Reply" })
    expect({
      focused: document.activeElement === trigger,
      state: trigger.getAttribute("data-state"),
      childRef: ref.current === trigger,
    }).toEqual({ focused: true, state: "instant-open", childRef: true })
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Reply in thread")
  })

  // The hover swaps the trigger node; a browser hit-tests the click onto the new
  // one, while user-event would dispatch it to the stale node it was handed.
  it("keeps the trigger's own handlers on the node it swaps in", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    renderTooltip({ onClick })
    await user.hover(screen.getByRole("button", { name: "Reply" }))
    await user.click(screen.getByRole("button", { name: "Reply" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe("LazyHoverCard", () => {
  it("mounts only the bare trigger while closed and opens on the first hover", async () => {
    const user = userEvent.setup()
    pointerRestsOnTrigger()
    render(
      <LazyHoverCard openDelay={0} trigger={<button type="button">Save</button>}>
        <HoverCardContent>Remind me</HoverCardContent>
      </LazyHoverCard>
    )
    const trigger = screen.getByRole("button", { name: "Save" })
    expect(trigger).not.toHaveAttribute("data-state")

    await user.hover(trigger)
    expect(await screen.findByText("Remind me")).toBeInTheDocument()
  })
  it("starts one open timer when the browser also enters the swapped-in trigger", async () => {
    const user = userEvent.setup({ delay: null })
    pointerRestsOnTrigger()
    render(
      <LazyHoverCard openDelay={100} closeDelay={0} trigger={<button type="button">Save</button>}>
        <HoverCardContent>Remind me</HoverCardContent>
      </LazyHoverCard>
    )
    await user.hover(screen.getByRole("button", { name: "Save" }))
    // user-event keeps addressing the node it hovered, so the swapped-in node's
    // boundary events are fired directly.
    const swappedIn = screen.getByRole("button", { name: "Save" })
    fireEvent.pointerOver(swappedIn)
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    fireEvent.pointerOut(swappedIn, { relatedTarget: document.body })

    await act(() => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(screen.queryByText("Remind me")).not.toBeInTheDocument()
  })
})

describe("LazyDropdownMenu", () => {
  it("mounts only the bare trigger while closed", () => {
    render(<Menu />)
    const trigger = screen.getByRole("button", { name: "Actions" })
    expect({
      state: trigger.getAttribute("data-state"),
      haspopup: trigger.getAttribute("aria-haspopup"),
      expanded: trigger.getAttribute("aria-expanded"),
    }).toEqual({ state: null, haspopup: "menu", expanded: "false" })
  })

  it("mounts open when opened from outside before it was ever armed", () => {
    render(
      <LazyDropdownMenu open onOpenChange={() => {}} trigger={<button type="button">Actions</button>}>
        <DropdownMenuContent>
          <DropdownMenuItem>Edit</DropdownMenuItem>
        </DropdownMenuContent>
      </LazyDropdownMenu>
    )
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument()
  })

  it("opens on pointer and returns focus to the trigger on Escape", async () => {
    const user = userEvent.setup()
    render(<Menu />)
    await user.click(screen.getByRole("button", { name: "Actions" }))
    expect(await screen.findByRole("menu")).toBeInTheDocument()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus()
  })

  it.each(["{Enter}", " ", "{ArrowDown}"])("opens from the keyboard (%s) with the first item focused", async (key) => {
    const user = userEvent.setup()
    render(<Menu />)
    await user.tab()
    expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus()

    await user.keyboard(key)
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toHaveFocus()
  })
})

describe("LazyPopover", () => {
  it("mounts only the bare trigger while closed", () => {
    render(<DatePopover />)
    const trigger = screen.getByRole("button", { name: "Jump" })
    expect({ state: trigger.getAttribute("data-state"), haspopup: trigger.getAttribute("aria-haspopup") }).toEqual({
      state: null,
      haspopup: "dialog",
    })
  })

  it("opens on click and returns focus to the trigger on Escape", async () => {
    const user = userEvent.setup()
    render(<DatePopover />)
    await user.click(screen.getByRole("button", { name: "Jump" }))
    expect(await screen.findByRole("dialog")).toHaveTextContent("Pick a date")

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Jump" })).toHaveFocus()
  })

  it("opens from the keyboard", async () => {
    const user = userEvent.setup()
    render(<DatePopover />)
    await user.tab()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("dialog")).toHaveTextContent("Pick a date")
  })
})
