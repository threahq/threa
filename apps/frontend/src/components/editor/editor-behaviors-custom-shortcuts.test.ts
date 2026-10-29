import { describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "./editor-extensions"
import { EditorBehaviors } from "./editor-behaviors"
import { getEffectiveEditorBindings, resolveShortcutBindingUpdate } from "@/lib/keyboard-shortcuts"

function createEditorWithBindings(bindings: Record<string, string>) {
  const element = document.createElement("div")
  document.body.append(element)

  const keyBindingsRef = { current: bindings }

  const editor = new Editor({
    element,
    extensions: [
      ...createEditorExtensions({ placeholder: "Type..." }),
      EditorBehaviors.configure({
        sendModeRef: { current: "enter" },
        onSubmitRef: { current: () => {} },
        keyBindingsRef,
      }),
    ],
    content: "<p>hello</p>",
  })

  editor.view.hasFocus = () => true
  editor.on("destroy", () => element.remove())

  return { editor, keyBindingsRef }
}

function pressKey(editor: Editor, key: string, options: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  })

  let handled = false
  editor.view.someProp("handleKeyDown", (fn) => {
    if (fn(editor.view, event)) {
      handled = true
      return true
    }
    return false
  })
  return handled
}

describe("editor custom formatting shortcuts", () => {
  it.each([
    { action: "formatItalic", binding: "mod+i", key: "i", mark: "italic", selector: "em", event: { metaKey: true } },
    {
      action: "formatStrike",
      binding: "mod+shift+s",
      key: "s",
      mark: "strike",
      selector: "s",
      event: { metaKey: true, shiftKey: true },
    },
  ])("triggers $mark through the default $action binding", ({ action, binding, key, mark, selector, event }) => {
    const bindings = getEffectiveEditorBindings({})
    expect(bindings[action]).toBe(binding)

    const { editor } = createEditorWithBindings(bindings)
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size })

    const handled = pressKey(editor, key, event)

    expect(handled).toBe(true)
    expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({ text: "hello", marks: [{ type: mark }] })
    expect(editor.view.dom.querySelector(selector)?.textContent).toBe("hello")
    editor.destroy()
  })

  it("triggers bold when pressing the custom binding mod+f", () => {
    const { editor } = createEditorWithBindings({ formatBold: "mod+f" })

    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size })
    const handled = pressKey(editor, "f", { metaKey: true })

    expect(handled).toBe(true)
    expect(editor.isActive("bold")).toBe(true)
    editor.destroy()
  })

  it("triggers bold when pressing mod+å (non-ASCII key)", () => {
    const { editor } = createEditorWithBindings({ formatBold: "mod+å" })

    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size })
    const handled = pressKey(editor, "å", { metaKey: true })

    expect(handled).toBe(true)
    expect(editor.isActive("bold")).toBe(true)
    editor.destroy()
  })

  it("resolveShortcutBindingUpdate + getEffectiveEditorBindings: remapping formatBold to mod+f disables searchInStream and keeps formatBold active in editor", () => {
    const nextBindings = resolveShortcutBindingUpdate({}, "formatBold", "mod+f")
    expect(nextBindings).toEqual({ searchInStream: "none", formatBold: "mod+f" })

    const editorBindings = getEffectiveEditorBindings(nextBindings)
    expect(editorBindings.formatBold).toBe("mod+f")
  })

  it("end-to-end: user remaps formatBold to mod+f, editor triggers bold", () => {
    const nextBindings = resolveShortcutBindingUpdate({}, "formatBold", "mod+f")
    const editorBindings = getEffectiveEditorBindings(nextBindings)

    const { editor } = createEditorWithBindings(editorBindings)
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size })

    const handled = pressKey(editor, "f", { metaKey: true })
    expect(handled).toBe(true)
    expect(editor.isActive("bold")).toBe(true)
    editor.destroy()
  })

  it("picks up bindings that are mutated into keyBindingsRef AFTER editor construction (reactive)", () => {
    const { editor, keyBindingsRef } = createEditorWithBindings({})

    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size })

    // Before: empty bindings → nothing handles mod+f
    let handled = pressKey(editor, "f", { metaKey: true })
    expect(handled).toBe(false)
    expect(editor.isActive("bold")).toBe(false)

    // Mutate ref AFTER construction (simulates preferences loading async)
    keyBindingsRef.current = { formatBold: "mod+f" }

    handled = pressKey(editor, "f", { metaKey: true })
    expect(handled).toBe(true)
    expect(editor.isActive("bold")).toBe(true)
    editor.destroy()
  })

  it("does NOT trigger bold with default mod+b when custom binding replaces it", () => {
    const { editor } = createEditorWithBindings({ formatBold: "mod+f" })

    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size })
    const handled = pressKey(editor, "b", { metaKey: true })

    expect(handled).toBe(false)
    expect(editor.isActive("bold")).toBe(false)
    editor.destroy()
  })
})
