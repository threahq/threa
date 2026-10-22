import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useCallback, useState } from "react"
import { __resetCollapseCacheForTests } from "./collapse-cache"
import { CollapsibleBody, type CollapsibleBodyGroup } from "./collapsible-body"
import { MarkdownBlockProvider, useIsInsideCollapsibleBlock, useMarkdownBlockContext } from "./markdown-block-context"

function ScopeProbe({ label }: { label: string }) {
  const scope = useMarkdownBlockContext()
  return <span>{`${label}:${scope?.messageId ?? "none"}`}</span>
}

function NestedProbe() {
  return <span>{`nested:${useIsInsideCollapsibleBlock()}`}</span>
}

function NestedChrome() {
  return useIsInsideCollapsibleBlock() ? <span>plain</span> : <span data-nested-chrome>chrome</span>
}

/** A nested quote's fold header and padding add to the body's height only while it keeps them. */
function mockBodyHeight(heights: { chrome: number; plain: number }) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() =>
    document.querySelector("[data-nested-chrome]") ? heights.chrome : heights.plain
  )
}

function captureResizeObservers() {
  const callbacks: Array<() => void> = []
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        callbacks.push(callback)
      }
      observe() {}
      disconnect() {}
    }
  )
  return () => act(() => callbacks.forEach((callback) => callback()))
}

/** A same-author run with a short sibling, open only while the pair measures tall. */
function OpenRunWithShortSibling() {
  const [tall, setTall] = useState(false)
  const onHeight = useCallback((heightPx: number) => setTall(heightPx + 23 > 420), [])
  return (
    <MarkdownBlockProvider messageId="msg_1">
      <CollapsibleBody
        kind="message"
        content="body"
        collapseAtHeight={420}
        collapseToHeight={240}
        group={tall ? { collapsed: false, toggleLabel: null, onToggle: () => {} } : undefined}
        onHeight={onHeight}
      >
        <NestedChrome />
      </CollapsibleBody>
    </MarkdownBlockProvider>
  )
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
    vi.unstubAllGlobals()
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

  it("keeps nested folds taken over when dropping their chrome shrinks the body, until the content changes", () => {
    const resize = captureResizeObservers()
    mockBodyHeight({ chrome: 440, plain: 400 })
    const body = (content: string) => (
      <MarkdownBlockProvider messageId="msg_1">
        <CollapsibleBody
          kind="message"
          content={content}
          collapseAtHeight={420}
          collapseToHeight={240}
          defaultCollapsed={false}
        >
          <NestedChrome />
        </CollapsibleBody>
      </MarkdownBlockProvider>
    )

    const { rerender } = render(body("body"))
    resize()

    expect(screen.getByText("plain")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument()

    mockBodyHeight({ chrome: 410, plain: 400 })
    rerender(body("edited body"))

    expect(screen.getByText("chrome")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Collapse" })).not.toBeInTheDocument()
  })

  it("keeps an open run tall when dropping the nested chrome shrinks its body", () => {
    const resize = captureResizeObservers()
    mockBodyHeight({ chrome: 430, plain: 395 })
    render(<OpenRunWithShortSibling />)

    const perTick = Array.from({ length: 4 }, () => {
      resize()
      return {
        nested: screen.getByText(/plain|chrome/).textContent,
        ownFold: screen.queryByRole("button", { name: /Collapse|Show more/ })?.textContent ?? null,
      }
    })

    expect(perTick).toEqual(Array(4).fill({ nested: "plain", ownFold: null }))
  })

  it("releases the fold when the body itself shrinks under the threshold", () => {
    const resize = captureResizeObservers()
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(450)
    render(
      <MarkdownBlockProvider messageId="msg_1">
        <CollapsibleBody kind="message" content="body" collapseAtHeight={420} collapseToHeight={240}>
          <span>body</span>
        </CollapsibleBody>
      </MarkdownBlockProvider>
    )
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument()

    height.mockReturnValue(200)
    resize()

    expect(screen.queryByRole("button", { name: /Collapse|Show more/ })).not.toBeInTheDocument()
  })

  it("reports the restored chrome when it hands nested folds back", () => {
    const resize = captureResizeObservers()
    mockBodyHeight({ chrome: 440, plain: 400 })
    const heights: number[] = []
    render(
      <MarkdownBlockProvider messageId="msg_1">
        <CollapsibleBody
          kind="message"
          content="body"
          collapseAtHeight={420}
          collapseToHeight={240}
          defaultCollapsed={false}
          onHeight={(heightPx) => heights.push(heightPx)}
        >
          <NestedChrome />
        </CollapsibleBody>
      </MarkdownBlockProvider>
    )

    mockBodyHeight({ chrome: 300, plain: 260 })
    resize()
    resize()

    expect({ nested: screen.getByText(/plain|chrome/).textContent, heights }).toEqual({
      nested: "chrome",
      heights: [440, 300],
    })
  })

  it("measures the chrome afresh when a run folds in the same render as an edit", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => {
      const chrome = document.querySelector("[data-nested-chrome]") ? 40 : 0
      return (document.body.textContent?.includes("edited") ? 110 : 370) + chrome
    })
    const body = (content: string, collapsed: boolean) => (
      <MarkdownBlockProvider messageId="msg_1">
        <CollapsibleBody
          kind="message"
          content={content}
          collapseAtHeight={420}
          collapseToHeight={240}
          group={{ collapsed, toggleLabel: null, onToggle: () => {} }}
        >
          <NestedChrome />
          <span>{content}</span>
        </CollapsibleBody>
      </MarkdownBlockProvider>
    )

    const { rerender } = render(body("body", false))
    rerender(body("edited body", true))

    expect(screen.getByText("chrome")).toBeInTheDocument()
  })

  it("leaves a folded run's head unclamped when it fits once its nested chrome is stripped", () => {
    mockBodyHeight({ chrome: 260, plain: 225 })
    render(
      <MarkdownBlockProvider messageId="msg_1">
        <CollapsibleBody
          kind="message"
          content="body"
          collapseAtHeight={420}
          collapseToHeight={240}
          group={{ collapsed: true, toggleLabel: null, onToggle: () => {} }}
        >
          <NestedChrome />
        </CollapsibleBody>
      </MarkdownBlockProvider>
    )

    const clamp = screen.getByText(/plain|chrome/).parentElement!
    expect({ nested: clamp.textContent, maxHeight: clamp.style.maxHeight }).toEqual({ nested: "plain", maxHeight: "" })
  })

  it("hands nested folds back when a folded run opens or stops folding", () => {
    mockBodyHeight({ chrome: 300, plain: 260 })
    const body = (group: CollapsibleBodyGroup | undefined) => (
      <MarkdownBlockProvider messageId="msg_1">
        <CollapsibleBody kind="message" content="body" collapseAtHeight={420} collapseToHeight={240} group={group}>
          <NestedChrome />
        </CollapsibleBody>
      </MarkdownBlockProvider>
    )

    const { rerender } = render(body({ collapsed: true, toggleLabel: null, onToggle: () => {} }))
    expect(screen.getByText("plain")).toBeInTheDocument()

    rerender(body({ collapsed: false, toggleLabel: null, onToggle: () => {} }))
    expect(screen.getByText("chrome")).toBeInTheDocument()

    rerender(body(undefined))
    expect(screen.getByText("chrome")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Collapse|Show more/ })).not.toBeInTheDocument()
  })
})
