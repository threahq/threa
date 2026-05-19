import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD } from "@threa/types"
import { db } from "@/db"
import CodeBlock from "./code-block"
import { MarkdownBlockProvider, hashMarkdownBlock, composeBlockCollapseKey } from "./markdown-block-context"
import { hydrateCollapseCache } from "./collapse-cache"
import * as preferencesModule from "@/contexts/preferences-context"
import * as lineMeasureModule from "./use-measured-line-count"

// Stubbable preferences mock: each test can override via `currentPrefs`.
let currentPrefs: { codeBlockCollapseThreshold?: number } | null = {
  codeBlockCollapseThreshold: DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD,
}

// JSDOM has no layout engine, so `useMeasuredLineCount` can never observe a
// real rendered height. Drive it from a mutable value the test controls so we
// can exercise "short → no chrome" and "long → collapsed clamp" deterministically.
let measure: lineMeasureModule.MeasuredLines = { lineCount: 2, lineHeightPx: 20 }

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

function renderCodeBlock(code: string, messageId = "msg_test", language = "typescript") {
  return render(
    <MarkdownBlockProvider messageId={messageId}>
      <CodeBlock language={language}>{code}</CodeBlock>
    </MarkdownBlockProvider>
  )
}

/** Inline `max-height` clamp the collapsed body carries, if any. */
function clampStyle(): string | undefined {
  const el = document.querySelector<HTMLElement>('[style*="max-height"]')
  return el?.style.maxHeight || undefined
}

describe("CodeBlock collapse behavior", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.spyOn(preferencesModule, "usePreferences").mockImplementation(() => {
      const value = buildPreferencesContext()
      if (!value) throw new Error("no preferences")
      return value
    })
    vi.spyOn(preferencesModule, "usePreferencesOptional").mockImplementation(() => buildPreferencesContext())
    vi.spyOn(lineMeasureModule, "useMeasuredLineCount").mockImplementation(() => measure)

    currentPrefs = { codeBlockCollapseThreshold: DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD }
    measure = { lineCount: 2, lineHeightPx: 20 }
    await db.markdownBlockCollapse.clear()
  })

  afterEach(async () => {
    await db.markdownBlockCollapse.clear()
  })

  it("renders short code blocks (≤ threshold) with no collapse chrome", async () => {
    measure = { lineCount: 2, lineHeightPx: 20 }
    renderCodeBlock("const x = 1\nconst y = 2")

    expect(screen.queryByText(/click to expand/i)).not.toBeInTheDocument()
    expect(clampStyle()).toBeUndefined()
    // Flush the async highlight so the trailing setState doesn't escape act().
    await waitFor(() => expect(document.querySelector("pre")).toBeInTheDocument())
  })

  it("collapses long code blocks (> threshold) by default and clamps to threshold + half a line", async () => {
    measure = { lineCount: 25, lineHeightPx: 20 }
    const code = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n")
    renderCodeBlock(code)

    // Header advertises the measured total + the expand affordance.
    expect(screen.getByText(/25 lines, click to expand/i)).toBeInTheDocument()

    // The half-line peek: clamp = (threshold + 0.5) × line-height.
    const expected = `${(DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD + 0.5) * 20}px`
    await waitFor(() => expect(clampStyle()).toBe(expected))

    // Full code stays mounted (clamped by CSS, never sliced).
    const pre = document.querySelector("pre")
    expect(pre?.textContent).toContain("line 1")
    expect(pre?.textContent).toContain("line 25")
  })

  it("expanding a collapsed block drops the clamp and keeps the full content", async () => {
    const user = userEvent.setup()
    measure = { lineCount: 25, lineHeightPx: 20 }
    const code = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n")
    renderCodeBlock(code, "msg_expand_full")

    await waitFor(() => expect(clampStyle()).toBeDefined())

    await user.click(screen.getByRole("button", { name: /expand 25 lines/i }))

    await waitFor(() => {
      expect(clampStyle()).toBeUndefined()
      expect(screen.getByRole("button", { name: /collapse code block/i })).toHaveAttribute("aria-expanded", "true")
    })
    expect(document.querySelector("pre")?.textContent).toContain("line 25")
  })

  it("uses the user's threshold override when one is set", async () => {
    currentPrefs = { codeBlockCollapseThreshold: 3 }
    measure = { lineCount: 5, lineHeightPx: 18 }
    renderCodeBlock("line 1\nline 2\nline 3\nline 4\nline 5")

    // 5 measured lines > threshold 3 → collapsed by default.
    expect(screen.getByText(/5 lines, click to expand/i)).toBeInTheDocument()
    await waitFor(() => expect(clampStyle()).toBe(`${(3 + 0.5) * 18}px`))
  })

  it("treats a threshold of 0 as 'collapse all non-empty blocks'", async () => {
    currentPrefs = { codeBlockCollapseThreshold: 0 }
    measure = { lineCount: 1, lineHeightPx: 20 }
    renderCodeBlock("const x = 1")

    expect(screen.getByText(/1 line, click to expand/i)).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector("pre")).toBeInTheDocument())
  })

  it("toggles collapsed → expanded on click and persists the choice to IDB", async () => {
    const user = userEvent.setup()
    measure = { lineCount: 20, lineHeightPx: 20 }
    const code = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")
    const messageId = "msg_toggle_expand"
    renderCodeBlock(code, messageId)

    await user.click(screen.getByRole("button", { name: /expand 20 lines/i }))

    await waitFor(() => expect(clampStyle()).toBeUndefined())

    const key = composeBlockCollapseKey(messageId, "code", hashMarkdownBlock(code.trim(), "typescript"))
    const row = await db.markdownBlockCollapse.get(key)
    expect(row?.collapsed).toBe(false)
    expect(row?.kind).toBe("code")
  })

  it("toggles expanded → collapsed on click and persists the choice", async () => {
    const user = userEvent.setup()
    measure = { lineCount: 20, lineHeightPx: 20 }
    const code = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")
    const messageId = "msg_toggle_collapse"
    const key = composeBlockCollapseKey(messageId, "code", hashMarkdownBlock(code.trim(), "typescript"))

    // Seed an expanded override so the block starts open.
    await act(async () => {
      await db.markdownBlockCollapse.put({
        id: key,
        messageId,
        kind: "code",
        collapsed: false,
        updatedAt: Date.now(),
      })
      await hydrateCollapseCache()
    })

    renderCodeBlock(code, messageId)

    await user.click(screen.getByRole("button", { name: /collapse code block/i }))

    await waitFor(() => {
      expect(screen.getByText(/20 lines, click to expand/i)).toBeInTheDocument()
    })

    const row = await db.markdownBlockCollapse.get(key)
    expect(row?.collapsed).toBe(true)
  })

  it("restores a persisted expand override on subsequent renders", async () => {
    measure = { lineCount: 30, lineHeightPx: 20 }
    const code = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")
    const messageId = "msg_persisted"
    const key = composeBlockCollapseKey(messageId, "code", hashMarkdownBlock(code.trim(), "typescript"))

    await act(async () => {
      await db.markdownBlockCollapse.put({
        id: key,
        messageId,
        kind: "code",
        collapsed: false,
        updatedAt: Date.now(),
      })
      await hydrateCollapseCache()
    })

    renderCodeBlock(code, messageId)

    // A collapsible block would default collapsed; the persisted override keeps
    // it expanded (no clamp, no "click to expand" affordance).
    await waitFor(() => {
      expect(screen.queryByText(/click to expand/i)).not.toBeInTheDocument()
      expect(clampStyle()).toBeUndefined()
    })
  })

  it('marks the wrapper with data-native-context="true" so mobile long-press defers to native text selection', async () => {
    renderCodeBlock("const x = 1\nconst y = 2")
    expect(document.querySelector('[data-native-context="true"]')).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector("pre")).toBeInTheDocument())
  })

  it("scopes collapse state per messageId", async () => {
    const user = userEvent.setup()
    measure = { lineCount: 15, lineHeightPx: 20 }
    const code = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n")

    const { unmount } = renderCodeBlock(code, "msg_A")
    await user.click(screen.getByRole("button", { name: /expand 15 lines/i }))
    await waitFor(() => expect(clampStyle()).toBeUndefined())
    unmount()

    // Second message with the exact same content should not inherit the expand.
    renderCodeBlock(code, "msg_B")
    expect(screen.getByText(/15 lines, click to expand/i)).toBeInTheDocument()
  })
})
