import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetCollapseCacheForTests } from "./collapse-cache"
import { CollapsibleBody } from "./collapsible-body"
import { MarkdownBlockProvider, useMarkdownBlockContext } from "./markdown-block-context"

function ScopeProbe({ label }: { label: string }) {
  const scope = useMarkdownBlockContext()
  return <span>{`${label}:${scope?.messageId ?? "none"}`}</span>
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
})
