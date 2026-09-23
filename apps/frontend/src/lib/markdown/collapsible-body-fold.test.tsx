import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetCollapseCacheForTests } from "./collapse-cache"
import { CollapsibleBody } from "./collapsible-body"
import { MarkdownBlockProvider, useIsInsideCollapsibleBlock, useMarkdownBlockContext } from "./markdown-block-context"

function ScopeProbe({ label }: { label: string }) {
  const scope = useMarkdownBlockContext()
  return <span>{`${label}:${scope?.messageId ?? "none"}`}</span>
}

function NestedProbe() {
  return <span>{`nested:${useIsInsideCollapsibleBlock()}`}</span>
}

describe("CollapsibleBody trailing content", () => {
  beforeEach(() => {
    __resetCollapseCacheForTests()
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000)
    const realComputedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = realComputedStyle(el)
      return new Proxy(style, {
        get: (target, prop) => {
          if (prop === "lineHeight") return "20px"
          const value = Reflect.get(target, prop)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("folds attachments and previews inside the clamp, outside the message's block scope", async () => {
    const user = userEvent.setup()
    render(
      <MarkdownBlockProvider messageId="msg_1">
        <CollapsibleBody
          kind="message"
          content="long body"
          collapseAtHeight={420}
          collapseToHeight={240}
          trailing={<ScopeProbe label="preview" />}
        >
          <ScopeProbe label="body" />
        </CollapsibleBody>
      </MarkdownBlockProvider>
    )

    const clamp = screen.getByText("body:msg_1").parentElement!
    expect(clamp.style.maxHeight).toBe("240px")
    expect(clamp).toContainElement(screen.getByText("preview:none"))

    await user.click(screen.getByRole("button", { name: "Show more" }))
    expect(clamp.style.maxHeight).toBe("")
    expect(screen.getByRole("button", { name: "Collapse" })).toHaveAttribute("aria-expanded", "true")
  })

  it("keeps trailing controls clipped by the fold out of the tab order until expanded", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const top = Number(this.getAttribute("data-top") ?? 0)
      const height = Number(this.getAttribute("data-height") ?? 400)
      return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top } as DOMRect
    })
    const user = userEvent.setup()
    render(
      <MarkdownBlockProvider messageId="msg_1">
        <CollapsibleBody
          kind="message"
          content="long body"
          collapseAtHeight={420}
          collapseToHeight={240}
          trailing={
            <div data-top="200" data-height="200">
              <button data-top="200" data-height="30">
                Visible
              </button>
              <button data-top="300" data-height="30">
                Clipped
              </button>
            </div>
          }
        >
          <span>body</span>
        </CollapsibleBody>
      </MarkdownBlockProvider>
    )

    expect(screen.getByText("Visible")).not.toHaveAttribute("inert")
    expect(screen.getByText("Clipped")).toHaveAttribute("inert")

    await user.click(screen.getByRole("button", { name: "Show more" }))
    expect(screen.getByText("Clipped")).not.toHaveAttribute("inert")
  })

  it("leaves nested blocks their own fold when a run holds a short body", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100)
    const group = { collapsed: false, toggleLabel: null, onToggle: () => {} }
    render(
      <MarkdownBlockProvider messageId="msg_1">
        <CollapsibleBody kind="message" content="short" collapseAtHeight={420} collapseToHeight={240} group={group}>
          <NestedProbe />
        </CollapsibleBody>
      </MarkdownBlockProvider>
    )

    expect(screen.getByText("nested:false")).toBeInTheDocument()
  })

  it("takes over nested folds while a run clamps the body", () => {
    const group = { collapsed: true, toggleLabel: null, onToggle: () => {} }
    render(
      <MarkdownBlockProvider messageId="msg_1">
        <CollapsibleBody
          kind="message"
          content="long body"
          collapseAtHeight={2000}
          collapseToHeight={240}
          group={group}
        >
          <NestedProbe />
        </CollapsibleBody>
      </MarkdownBlockProvider>
    )

    expect(screen.getByText("nested:true")).toBeInTheDocument()
  })
})
