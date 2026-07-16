import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { JSONContent } from "@threa/types"
import { applyExternalEditorContent, type ExternalContentEditor } from "./apply-external-content"

const DOC: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }

/**
 * A structural editor fake. `setContentImpl` runs inside the mocked `setContent`
 * and receives the editor, so a case can throw or simulate the contenteditable
 * replace dropping focus (`editor.isFocused = false`).
 */
function makeEditor(opts: { isFocused?: boolean; setContentImpl?: (editor: ExternalContentEditor) => void } = {}): {
  editor: ExternalContentEditor
  setContent: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
} {
  const focus = vi.fn()
  const editor: ExternalContentEditor = {
    isFocused: opts.isFocused ?? false,
    commands: {
      setContent: vi.fn(() => opts.setContentImpl?.(editor)),
      focus,
    },
  }
  return { editor, setContent: editor.commands.setContent as ReturnType<typeof vi.fn>, focus }
}

describe("applyExternalEditorContent", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("applies the content and clears the internal-update guard", () => {
    const { editor, setContent } = makeEditor()
    const isInternalUpdate = { current: false }

    const applied = applyExternalEditorContent(editor, DOC, isInternalUpdate)

    expect(applied).toBe(true)
    expect(setContent).toHaveBeenCalledWith(DOC)
    expect(isInternalUpdate.current).toBe(false)
  })

  it("never strands the internal-update guard when setContent throws", () => {
    // The load-bearing guarantee: a throw must not leave `isInternalUpdate` true,
    // which would freeze the editor and swallow every later onUpdate (the composer
    // going dead until a remount — the draft-restore failure this hardens).
    const { editor } = makeEditor({
      setContentImpl: () => {
        throw new Error("unparseable doc")
      },
    })
    const isInternalUpdate = { current: false }

    const applied = applyExternalEditorContent(editor, DOC, isInternalUpdate)

    expect(applied).toBe(false)
    expect(isInternalUpdate.current).toBe(false)
  })

  it("restores focus after a successful replace if focus was dropped", () => {
    // contenteditable replace can drop focus; the helper re-focuses to keep the
    // mobile keyboard open.
    const { editor, focus } = makeEditor({
      isFocused: true,
      setContentImpl: (e) => {
        e.isFocused = false
      },
    })
    const isInternalUpdate = { current: false }

    applyExternalEditorContent(editor, DOC, isInternalUpdate)

    expect(focus).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledWith("end")
  })

  it("moves the caret to the end when the doc is replaced while focused", () => {
    // Focus follows the content: setContent leaves the selection at the doc
    // start, which strands the caret before a just-restored draft body.
    const { editor, focus } = makeEditor({ isFocused: true })
    const isInternalUpdate = { current: false }

    applyExternalEditorContent(editor, DOC, isInternalUpdate)

    expect(focus).toHaveBeenCalledWith("end")
  })

  it("does not touch focus when the editor was not focused", () => {
    const { editor, focus } = makeEditor({ isFocused: false })
    const isInternalUpdate = { current: false }

    applyExternalEditorContent(editor, DOC, isInternalUpdate)

    expect(focus).not.toHaveBeenCalled()
  })

  it("does not try to restore focus when the content failed to apply", () => {
    const { editor, focus } = makeEditor({
      isFocused: true,
      setContentImpl: () => {
        throw new Error("boom")
      },
    })
    const isInternalUpdate = { current: false }

    applyExternalEditorContent(editor, DOC, isInternalUpdate)

    expect(focus).not.toHaveBeenCalled()
  })
})
