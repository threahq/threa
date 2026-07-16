import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import type { SuggestionProps } from "@tiptap/suggestion"
import { useSuggestion } from "./use-suggestion"
import { useEmojiSuggestion } from "./use-emoji-suggestion"
import type { EmojiEntry } from "@threa/types"

interface Item {
  id: string
  label: string
}

type Config = ReturnType<typeof useSuggestion<Item>>["suggestionConfig"]

function Harness({ capture }: { capture: (cfg: Config) => void }) {
  const { suggestionConfig, renderSuggestionList } = useSuggestion<Item>({
    extensionName: "mention",
    getItems: () => [],
    filterItems: (items) => items,
    renderList: ({ items, command }) => (
      <div role="listbox" aria-label="suggestions">
        {items.map((item) => (
          <button key={item.id} role="option" aria-selected={false} onClick={() => command(item)}>
            {item.label}
          </button>
        ))}
      </div>
    ),
  })
  capture(suggestionConfig)
  return <>{renderSuggestionList()}</>
}

// Minimal editor stand-in: onStart/pointer-dismiss only touch storage,
// isDestroyed, and view.dom.
function makeFakeEditor(storage: Record<string, unknown>, dom: HTMLElement) {
  return { storage: { mention: storage, emoji: storage }, isDestroyed: false, view: { dom } }
}

function activate<T>(
  cfg: { render: () => { onStart: (props: SuggestionProps<T>) => void } },
  opts: {
    editor: unknown
    items: T[]
  }
) {
  const props = {
    editor: opts.editor,
    items: opts.items,
    query: "",
    clientRect: () => new DOMRect(0, 0, 0, 0),
    command: () => {},
  } as unknown as SuggestionProps<T>
  act(() => {
    cfg.render().onStart(props)
  })
}

let editorDom: HTMLDivElement

beforeEach(() => {
  editorDom = document.createElement("div")
  document.body.appendChild(editorDom)
})

afterEach(() => {
  editorDom.remove()
})

describe("useSuggestion outside-pointerdown dismiss", () => {
  const items = [{ id: "a", label: "Alice" }]

  function renderActive(storage: Record<string, unknown> = {}) {
    let cfg: Config | null = null
    render(<Harness capture={(c) => (cfg = c)} />)
    activate(cfg!, { editor: makeFakeEditor(storage, editorDom), items })
    expect(screen.getByRole("listbox")).toBeInTheDocument()
    return storage
  }

  it("closes the popup on a pointer down outside the popup and the editor", () => {
    const storage = renderActive({ popupVisible: true })
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    expect(storage.popupVisible).toBe(false)
  })

  it("keeps the popup when the pointer down lands on a list option", () => {
    renderActive()
    fireEvent.pointerDown(screen.getByRole("option", { name: "Alice" }))
    expect(screen.getByRole("listbox")).toBeInTheDocument()
  })

  it("keeps the popup when the pointer down lands inside the editor", () => {
    renderActive()
    fireEvent.pointerDown(editorDom)
    expect(screen.getByRole("listbox")).toBeInTheDocument()
  })
})

describe("useEmojiSuggestion outside-pointerdown dismiss", () => {
  const smile = { emoji: "😄", label: "smile", group: 0, order: 0, tags: [] } as unknown as EmojiEntry

  function EmojiHarness({
    capture,
  }: {
    capture: (cfg: ReturnType<typeof useEmojiSuggestion>["suggestionConfig"]) => void
  }) {
    const { suggestionConfig, renderEmojiGrid } = useEmojiSuggestion({ emojis: [smile], emojiWeights: {} })
    capture(suggestionConfig)
    return <>{renderEmojiGrid()}</>
  }

  it("closes the emoji grid on a pointer down outside the popup and the editor", () => {
    let cfg: ReturnType<typeof useEmojiSuggestion>["suggestionConfig"] | null = null
    render(<EmojiHarness capture={(c) => (cfg = c)} />)
    const storage: Record<string, unknown> = { popupVisible: true }
    activate(cfg!, { editor: makeFakeEditor(storage, editorDom), items: [smile] })
    expect(screen.getByRole("listbox")).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    expect(storage.popupVisible).toBe(false)
  })
})
