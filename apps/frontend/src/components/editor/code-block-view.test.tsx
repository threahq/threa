import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRef } from "react"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { parseMarkdown, serializeToMarkdown } from "@threahq/prosemirror"
import type { JSONContent } from "@threahq/types"
import { spyOnExport } from "@/test/spy"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as emojiModule from "@/hooks/use-workspace-emoji"
import * as giphyModule from "@/hooks/use-giphy-enabled"
import * as streamCommandsModule from "@/hooks/use-stream-commands"
import * as contextsModule from "@/contexts"
import { RichEditor, type RichEditorHandle } from "./rich-editor"
import { Fragment } from "@tiptap/pm/model"
import { DecorationSet } from "@tiptap/pm/view"
import { codeBlockHighlightKey } from "./code-block-highlight"

const NO_MENTIONABLES = { mentionables: [], isLoading: false }
const NO_EMOJI = { emojis: [], emojiWeights: {}, toEmoji: () => null, toShortcode: () => null }
const NO_PREFERENCES = { preferences: {} }

beforeEach(() => {
  spyOnExport(mentionablesModule, "useMentionables").mockReturnValue((() => NO_MENTIONABLES) as never)
  spyOnExport(emojiModule, "useWorkspaceEmoji").mockReturnValue((() => NO_EMOJI) as never)
  spyOnExport(giphyModule, "useGiphyEnabled").mockReturnValue((() => false) as never)
  spyOnExport(streamCommandsModule, "useStreamCommands").mockReturnValue((() => []) as never)
  spyOnExport(contextsModule, "usePreferences").mockReturnValue((() => NO_PREFERENCES) as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** `focusEndOnClick` mounts the editor the way the composer and settings hosts do: a click anywhere focuses its end. */
function mountEditor(markdown: string, { disabled = false, focusEndOnClick = false } = {}) {
  const ref = createRef<RichEditorHandle>()
  let content: JSONContent = parseMarkdown(markdown)

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <div onClick={focusEndOnClick ? () => ref.current?.getEditor()?.commands.focus("end") : undefined}>
          <RichEditor
            ref={ref}
            value={content}
            onChange={(json) => {
              content = json
            }}
            onSubmit={() => undefined}
            ariaLabel="Message input"
            disabled={disabled}
          />
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  )

  return { editor: ref.current!.getEditor()!, getMarkdown: () => serializeToMarkdown(content) }
}

describe("code block language chip", () => {
  it("sends the picked language as the fence info string and hands focus back to the code", async () => {
    const user = userEvent.setup()
    const { editor, getMarkdown } = mountEditor("```\nname: threa\n```")

    await user.click(await screen.findByRole("button", { name: "Code language: Plain text" }))
    await user.type(screen.getByPlaceholderText("Search languages"), "yml")
    await user.click(screen.getByRole("option", { name: "YAML" }))

    await waitFor(() => expect(editor.view.hasFocus()).toBe(true))
    expect({
      markdown: getMarkdown(),
      chip: screen.getByRole("button", { name: "Code language: YAML" }).textContent,
    }).toEqual({ markdown: "```yaml\nname: threa\n```", chip: "YAML" })
  })

  it("keeps the caret in the code when the language is picked with a click inside a host that focuses on click", async () => {
    const user = userEvent.setup()
    const { editor } = mountEditor("```\nname: threa\n```\n\nafter", { focusEndOnClick: true })
    editor.commands.setTextSelection(3)

    await user.click(await screen.findByRole("button", { name: "Code language: Plain text" }))
    await user.click(screen.getByRole("option", { name: "YAML" }))

    await waitFor(() => expect(editor.view.hasFocus()).toBe(true))
    expect({ open: screen.queryByPlaceholderText("Search languages"), caret: editor.state.selection.from }).toEqual({
      open: null,
      caret: 3,
    })
  })

  it("closes on Escape without changing the language", async () => {
    const user = userEvent.setup()
    const { getMarkdown } = mountEditor("```ts\nconst a = 1\n```")

    await user.click(await screen.findByRole("button", { name: "Code language: TypeScript" }))
    await user.keyboard("{Escape}")

    expect({ open: screen.queryByPlaceholderText("Search languages"), markdown: getMarkdown() }).toEqual({
      open: null,
      markdown: "```ts\nconst a = 1\n```",
    })
  })

  it("shows the language without a picker when the editor is read-only", async () => {
    mountEditor("```yaml\nname: threa\n```", { disabled: true })

    await screen.findByText("YAML")
    expect(screen.queryByRole("button", { name: /Code language/ })).toBeNull()
  })
})

describe("code block highlighting", () => {
  it("colours the code with the Shiki themes posted messages use", async () => {
    mountEditor("```yaml\nname: threa\n```")

    await waitFor(() => {
      const keyToken = [...document.querySelectorAll<HTMLElement>("pre code span[style]")].find(
        (span) => span.textContent === "name"
      )
      expect({
        light: keyToken?.style.getPropertyValue("--shiki-light"),
        dark: keyToken?.style.getPropertyValue("--shiki-dark"),
      }).toEqual({ light: expect.stringMatching(/^#[0-9a-f]{6}$/i), dark: expect.stringMatching(/^#[0-9a-f]{6}$/i) })
    })
  })

  it("re-decorates only the block that was edited", async () => {
    const { editor } = mountEditor("```yaml\na: 1\n```\n\n```yaml\nb: 2\n```")
    // The decoration subtree ProseMirror hands the second block's node view.
    const secondBlockDecorations = () => {
      const { doc } = editor.state
      return codeBlockHighlightKey.getState(editor.state)!.decorations.forChild(doc.child(0).nodeSize, doc.child(1))
    }
    await waitFor(() => expect(secondBlockDecorations()).not.toBe(DecorationSet.empty))
    const before = secondBlockDecorations()

    editor.commands.insertContentAt(2, "x")
    await waitFor(() => expect(codeBlockHighlightKey.getState(editor.state)!.dirty).toBeNull())

    expect({ text: editor.state.doc.child(0).textContent, same: secondBlockDecorations() === before }).toEqual({
      text: "ax: 1",
      same: true,
    })
  })

  it("keeps untouched blocks' decorations when a remote edit replaces the whole document", async () => {
    const { editor } = mountEditor("```yaml\na: 1\n```\n\n```yaml\nb: 2\n```")
    const secondBlockDecorations = () => {
      const { doc } = editor.state
      return codeBlockHighlightKey.getState(editor.state)!.decorations.forChild(doc.child(0).nodeSize, doc.child(1))
    }
    await waitFor(() => expect(secondBlockDecorations()).not.toBe(DecorationSet.empty))
    const before = secondBlockDecorations()

    // y-prosemirror applies a remote change as one replace of the whole document.
    const { doc, schema } = editor.state
    const edited = doc.child(0).copy(Fragment.from(schema.text("ax: 1")))
    editor.view.dispatch(editor.state.tr.replaceWith(0, doc.content.size, doc.content.replaceChild(0, edited)))
    await waitFor(() => expect(codeBlockHighlightKey.getState(editor.state)!.dirty).toBeNull())

    expect({ text: editor.state.doc.child(0).textContent, same: secondBlockDecorations() === before }).toEqual({
      text: "ax: 1",
      same: true,
    })
  })
})
