import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CodeBlockWrap } from "@threa/types"
import { CodeViewerProvider, useCodeViewerOptional } from "@/contexts/code-viewer-context"
import * as preferencesModule from "@/contexts/preferences-context"
import * as highlighterModule from "@/lib/markdown/highlighter"

const CODE = "SELECT *\nFROM users\nWHERE id = 1"

let currentPrefs: { codeBlockWrap?: CodeBlockWrap; codeBlockWrapOverrides?: Record<string, CodeBlockWrap> } = {}

function Trigger({ languageId = "sql" }: { languageId?: string }) {
  const viewer = useCodeViewerOptional()
  return (
    <button type="button" onClick={() => viewer?.open({ code: CODE, languageId })}>
      open viewer
    </button>
  )
}

function mount(languageId?: string) {
  render(
    <CodeViewerProvider>
      <Trigger languageId={languageId} />
    </CodeViewerProvider>
  )
}

function body() {
  return document.querySelector<HTMLElement>("[role='dialog'] [data-wrap]")
}

describe("CodeViewer", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    currentPrefs = {}
    vi.spyOn(preferencesModule, "usePreferencesOptional").mockImplementation(
      () => ({ preferences: currentPrefs }) as unknown as ReturnType<typeof preferencesModule.usePreferences>
    )
    vi.spyOn(highlighterModule, "tryHighlightSync").mockImplementation(
      (code) => `<pre class="shiki"><code>${code}</code></pre>`
    )
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  afterEach(() => vi.restoreAllMocks())

  it("should open full screen with the block's code, label, and line count", async () => {
    mount()
    await userEvent.click(screen.getByRole("button", { name: "open viewer" }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("SQL")
    expect(dialog).toHaveTextContent("3 lines")
    expect(body()?.textContent).toBe(CODE)
  })

  it("should seed the wrap toggle from the language override and flip it without writing the preference", async () => {
    currentPrefs = { codeBlockWrap: "scroll", codeBlockWrapOverrides: { sql: "wrap" } }
    mount()
    await userEvent.click(screen.getByRole("button", { name: "open viewer" }))
    await screen.findByRole("dialog")
    expect(body()).toHaveAttribute("data-wrap", "wrap")
    const toggle = screen.getByRole("button", { name: "Wrap lines" })
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(toggle)
    expect(body()).toHaveAttribute("data-wrap", "scroll")
    expect(toggle).toHaveAttribute("aria-pressed", "false")
  })

  it("should reset the toggle to the preference on the next open", async () => {
    currentPrefs = { codeBlockWrap: "scroll" }
    mount()
    await userEvent.click(screen.getByRole("button", { name: "open viewer" }))
    await screen.findByRole("dialog")
    await userEvent.click(screen.getByRole("button", { name: "Wrap lines" }))
    expect(body()).toHaveAttribute("data-wrap", "wrap")
    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole("button", { name: "open viewer" }))
    await screen.findByRole("dialog")
    expect(body()).toHaveAttribute("data-wrap", "scroll")
  })

  it("should copy the code and confirm in place", async () => {
    mount()
    await userEvent.click(screen.getByRole("button", { name: "open viewer" }))
    await screen.findByRole("dialog")
    await userEvent.click(screen.getByRole("button", { name: "Copy code" }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CODE)
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument()
  })

  it("should close on Escape", async () => {
    mount()
    await userEvent.click(screen.getByRole("button", { name: "open viewer" }))
    await screen.findByRole("dialog")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })
})
