import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD } from "@threa/types"
import { db } from "@/db"
import { BlockquoteBlock } from "./blockquote-block"
import { MarkdownBlockProvider, composeBlockCollapseKey, hashMarkdownBlock } from "./markdown-block-context"
import { hydrateCollapseCache } from "./collapse-cache"
import * as preferencesModule from "@/contexts/preferences-context"
import * as lineMeasureModule from "./use-measured-line-count"

// Stubbable preferences mock — each test can override via `currentPrefs`.
let currentPrefs: { blockquoteCollapseThreshold?: number } | null = {
  blockquoteCollapseThreshold: DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD,
}

// JSDOM can't lay out text, so the rendered-height measurement is driven from
// a mutable the test controls (short vs long → chrome / no chrome).
let measure: lineMeasureModule.MeasuredLines = { lineCount: 1, lineHeightPx: 22 }

function buildPreferencesContext() {
  if (!currentPrefs) return null
  return {
    preferences: currentPrefs,
    resolvedTheme: "light",
    isLoading: false,
    updatePreference: vi.fn(),
    updateAccessibility: vi.fn(),
    updateKeyboardShortcut: vi.fn(),
    resetKeyboardShortcut: vi.fn(),
    resetAllKeyboardShortcuts: vi.fn(),
  } as unknown as ReturnType<typeof preferencesModule.usePreferences>
}

function renderBlockquote(children: React.ReactNode, messageId = "msg_quote") {
  return render(
    <MarkdownBlockProvider messageId={messageId}>
      <BlockquoteBlock>{children}</BlockquoteBlock>
    </MarkdownBlockProvider>
  )
}

/** Inline `max-height` clamp the collapsed body carries, if any. */
function clampStyle(): string | undefined {
  const el = document.querySelector<HTMLElement>('[style*="max-height"]')
  return el?.style.maxHeight || undefined
}

describe("BlockquoteBlock collapse behavior", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.spyOn(preferencesModule, "usePreferences").mockImplementation(() => {
      const value = buildPreferencesContext()
      if (!value) throw new Error("no preferences")
      return value
    })
    vi.spyOn(preferencesModule, "usePreferencesOptional").mockImplementation(() => buildPreferencesContext())
    vi.spyOn(lineMeasureModule, "useMeasuredLineCount").mockImplementation(() => measure)
    currentPrefs = { blockquoteCollapseThreshold: DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD }
    measure = { lineCount: 1, lineHeightPx: 22 }
    await db.markdownBlockCollapse.clear()
  })

  afterEach(async () => {
    await db.markdownBlockCollapse.clear()
  })

  it("renders short quotes with no collapse chrome", () => {
    measure = { lineCount: 1, lineHeightPx: 22 }
    renderBlockquote(<p>A short quote.</p>)
    expect(screen.getByText("A short quote.")).toBeInTheDocument()
    expect(screen.queryByText(/click to expand/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(clampStyle()).toBeUndefined()
  })

  it("collapses long quotes by default and clamps to threshold + half a line", () => {
    currentPrefs = { blockquoteCollapseThreshold: 2 }
    measure = { lineCount: 3, lineHeightPx: 22 }
    renderBlockquote(
      <>
        <p>Paragraph one of the quote.</p>
        <p>Paragraph two continues the thought.</p>
        <p>Paragraph three ties it together.</p>
      </>
    )
    expect(screen.getByText(/3 lines, click to expand/i)).toBeInTheDocument()
    expect(clampStyle()).toBe(`${(2 + 0.5) * 22}px`)
  })

  it("a block quote also honors an explicit low threshold", () => {
    currentPrefs = { blockquoteCollapseThreshold: 0 }
    measure = { lineCount: 1, lineHeightPx: 20 }
    renderBlockquote(<p>Just one line.</p>)
    expect(screen.getByText(/1 line, click to expand/i)).toBeInTheDocument()
  })

  it("expanding a collapsed quote drops the clamp; full content stays mounted", async () => {
    const user = userEvent.setup()
    currentPrefs = { blockquoteCollapseThreshold: 1 }
    measure = { lineCount: 3, lineHeightPx: 22 }
    renderBlockquote(
      <>
        <p>First paragraph.</p>
        <p>Second paragraph.</p>
        <p>Third paragraph stays mounted, clamped by CSS.</p>
      </>
    )

    // Full content is always in the DOM; collapse is a visual clamp.
    expect(screen.getByText("Third paragraph stays mounted, clamped by CSS.")).toBeInTheDocument()
    expect(clampStyle()).toBe(`${(1 + 0.5) * 22}px`)

    await user.click(screen.getByRole("button", { name: /expand 3 lines/i }))

    await waitFor(() => {
      expect(clampStyle()).toBeUndefined()
      expect(screen.getByRole("button", { name: /collapse block quote/i })).toHaveAttribute("aria-expanded", "true")
    })
  })

  it("persists a user's toggle choice keyed by message + kind + content hash", async () => {
    const user = userEvent.setup()
    currentPrefs = { blockquoteCollapseThreshold: 1 }
    measure = { lineCount: 2, lineHeightPx: 22 }
    const messageId = "msg_persist_quote"
    renderBlockquote(
      <>
        <p>A quote that is long enough to be collapsed.</p>
        <p>With a second line for good measure.</p>
      </>,
      messageId
    )

    await user.click(screen.getByRole("button", { name: /expand/i }))

    await waitFor(async () => {
      const rows = await db.markdownBlockCollapse.where("messageId").equals(messageId).toArray()
      expect(rows).toHaveLength(1)
      expect(rows[0].kind).toBe("blockquote")
      expect(rows[0].collapsed).toBe(false)
    })
  })

  it("restores a persisted expand override on subsequent renders", async () => {
    currentPrefs = { blockquoteCollapseThreshold: 1 }
    measure = { lineCount: 5, lineHeightPx: 22 }
    const messageId = "msg_restore_quote"
    const text = "Preserved quote that is long enough to collapse."
    const hash = hashMarkdownBlock(text, "blockquote")
    const key = composeBlockCollapseKey(messageId, "blockquote", hash)

    await act(async () => {
      await db.markdownBlockCollapse.put({
        id: key,
        messageId,
        kind: "blockquote",
        collapsed: false,
        updatedAt: Date.now(),
      })
      await hydrateCollapseCache()
    })

    renderBlockquote(<p>{text}</p>, messageId)

    // Without the override a collapsible quote defaults collapsed; the override
    // keeps it expanded (no clamp, no affordance).
    await waitFor(() => {
      expect(screen.queryByText(/click to expand/i)).not.toBeInTheDocument()
      expect(clampStyle()).toBeUndefined()
    })
  })

  it("scopes collapse state per messageId", async () => {
    const user = userEvent.setup()
    currentPrefs = { blockquoteCollapseThreshold: 1 }
    measure = { lineCount: 4, lineHeightPx: 22 }
    const body = (
      <>
        <p>Shared quote content A.</p>
        <p>Shared quote content B.</p>
      </>
    )

    const { unmount } = renderBlockquote(body, "msg_quote_A")
    await user.click(screen.getByRole("button", { name: /expand/i }))
    await waitFor(() => expect(clampStyle()).toBeUndefined())
    unmount()

    // Second message with the same content should still collapse by default.
    renderBlockquote(body, "msg_quote_B")
    expect(screen.getByText(/click to expand/i)).toBeInTheDocument()
  })

  it("does not collide with code-block collapse entries for the same text", async () => {
    const user = userEvent.setup()
    currentPrefs = { blockquoteCollapseThreshold: 1 }
    measure = { lineCount: 3, lineHeightPx: 22 }
    const messageId = "msg_mixed"

    renderBlockquote(
      <>
        <p>const x = 1</p>
        <p>const y = 2</p>
      </>,
      messageId
    )

    await user.click(screen.getByRole("button", { name: /expand/i }))

    await waitFor(async () => {
      const rows = await db.markdownBlockCollapse.where("messageId").equals(messageId).toArray()
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.kind === "blockquote")).toBe(true)
    })
  })

  it("only the outermost blockquote folds when blockquotes are nested", () => {
    // Outer is long enough to be collapsible, so it provides the
    // inside-collapsible context that suppresses the inner block's chrome.
    currentPrefs = { blockquoteCollapseThreshold: 6 }
    measure = { lineCount: 25, lineHeightPx: 22 }
    render(
      <MarkdownBlockProvider messageId="msg_nested">
        <BlockquoteBlock>
          <p>Outer quote line.</p>
          <BlockquoteBlock>
            <p>Inner quote line.</p>
          </BlockquoteBlock>
        </BlockquoteBlock>
      </MarkdownBlockProvider>
    )

    // Exactly one fold toggle exists — the outer one (collapsed by default).
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName(/expand 25 lines/i)
    // Both bodies stay mounted (the outer is clamped, not sliced).
    expect(screen.getByText("Outer quote line.")).toBeInTheDocument()
    expect(screen.getByText("Inner quote line.")).toBeInTheDocument()
  })
})
