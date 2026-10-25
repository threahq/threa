import { describe, expect, it } from "vitest"
import { getSchema } from "@tiptap/core"
import type { Schema } from "@tiptap/pm/model"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import * as Y from "yjs"
import { createDocumentExtensions, createEditorExtensions } from "./editor-extensions"

// `parseDOM` rules hold closures that never compare equal; `allowGapCursor` is
// the gap-cursor extension's own addition.
const EDITOR_ONLY_SPEC_KEYS = new Set(["allowGapCursor", "parseDOM", "toDOM"])

function attrDefaults(attrs: Record<string, { default?: unknown }> | undefined) {
  return Object.fromEntries(Object.entries(attrs ?? {}).map(([name, spec]) => [name, spec.default]))
}

function specShape(name: string, spec: Record<string, unknown>) {
  const comparable = Object.entries(spec).filter(
    ([key, value]) => !EDITOR_ONLY_SPEC_KEYS.has(key) && typeof value !== "function" && key !== "attrs"
  )
  return { name, ...Object.fromEntries(comparable), attrs: attrDefaults(spec.attrs as never) }
}

function nodeShapes(schema: Schema) {
  return Object.entries(schema.nodes).map(([name, type]) => specShape(name, type.spec as never))
}

function markShapes(schema: Schema) {
  return Object.entries(schema.marks).map(([name, type]) => specShape(name, type.spec as never))
}

describe("editor schema parity", () => {
  const editorSchema = getSchema(createEditorExtensions("p"))
  const sharedSchema = getThreaSchema()

  it("should match the shared node specs apart from editor-only keys", () => {
    expect(nodeShapes(editorSchema)).toEqual(nodeShapes(sharedSchema))
  })

  it("should match the shared mark specs when the editor sets the link class", () => {
    const expected = markShapes(sharedSchema).map((mark) =>
      mark.name === "link" ? { ...mark, attrs: { ...mark.attrs, class: expect.any(String) } } : mark
    )

    expect(markShapes(editorSchema)).toEqual(expected)
  })

  it("should build the shared schema for the collaborative document editor", () => {
    const documentSchema = getSchema(createDocumentExtensions({ ydoc: new Y.Doc() }))

    expect({ nodes: nodeShapes(documentSchema), marks: markShapes(documentSchema) }).toEqual({
      nodes: nodeShapes(editorSchema),
      marks: markShapes(editorSchema),
    })
  })
})
