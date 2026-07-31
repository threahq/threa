import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { MarkdownContent } from "@/components/ui/markdown-content"

const PANE = "▐▛███▜▌   Claude Code v2.1.220\n▝▜█████▛▘  Opus 5\n  ▘▘ ▝▝    ~/dev/personal/threa"

function renderMarkdown(markdown: string) {
  return render(
    <MemoryRouter>
      <MarkdownContent content={markdown} />
    </MemoryRouter>
  ).container
}

describe("fenced code blocks", () => {
  it("renders a bare fence as a block, not as inline code", () => {
    // remark only sets `language-*` when the fence carries an info string, so a
    // bare ``` fence used to reach the inline-code branch: monospace, no
    // `white-space: pre`, and the newlines collapsed. `/status` posts its tmux
    // pane capture through exactly this path.
    const container = renderMarkdown(`**Current pane**\n\n\`\`\`\n${PANE}\n\`\`\`\n`)

    expect(container.querySelectorAll("pre")).toHaveLength(1)
    expect(container.querySelector("pre")?.textContent).toContain("Claude Code v2.1.220")
    expect(container.querySelector("code")?.className).not.toContain("break-all")
  })

  it("keeps the language when the fence declares one", () => {
    const container = renderMarkdown("```ts\nconst a = 1\n```\n")

    expect(container.querySelectorAll("pre")).toHaveLength(1)
    expect(container.textContent).toContain("const a = 1")
  })

  it("still renders single-backtick spans as inline code", () => {
    const container = renderMarkdown("a `token` here")

    expect(container.querySelectorAll("pre")).toHaveLength(0)
    expect(container.querySelector("code")?.className).toContain("break-all")
  })

  it("preserves every line of a captured pane", () => {
    const container = renderMarkdown(`\`\`\`\n${PANE}\n\`\`\`\n`)

    for (const line of PANE.split("\n")) {
      expect(container.querySelector("pre")?.textContent).toContain(line.trim())
    }
  })
})
