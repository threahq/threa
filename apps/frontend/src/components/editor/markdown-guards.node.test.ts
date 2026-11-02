import { describe, it, expect } from "vitest"
import { Schema } from "@tiptap/pm/model"
import { EditorState } from "@tiptap/pm/state"
import { isInBacktickWord, currentWordContainsBacktick, getParentTextBefore } from "./markdown-guards"

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
    hardBreak: {
      group: "inline",
      inline: true,
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
    mention: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { slug: { default: "" } },
      parseDOM: [{ tag: 'span[data-type="mention"]' }],
      toDOM: (node) => ["span", { "data-type": "mention" }, `@${node.attrs.slug}`],
    },
  },
})

function stateWithParagraph(text: string): EditorState {
  const doc = schema.nodes.doc.create({}, [schema.nodes.paragraph.create({}, [schema.text(text)])])
  return EditorState.create({ doc, schema })
}

describe("currentWordContainsBacktick", () => {
  it("returns false at the start of a paragraph", () => {
    const state = stateWithParagraph("hello")
    expect(isInBacktickWord(state, 1)).toBe(false)
  })

  it("returns false when the current word has no backtick", () => {
    const state = stateWithParagraph("hi _friend_")
    // Position at the end (after the closing underscore).
    expect(isInBacktickWord(state, state.doc.content.size - 1)).toBe(false)
  })

  it("returns true inside an unclosed backtick word", () => {
    // Matches the user's reproducer `pull_request/{review.rs,review_comment.rs}`
    // (with the closing backtick not yet typed).
    const state = stateWithParagraph("`pull_request/{review.rs,review_comment.rs}")
    expect(isInBacktickWord(state, state.doc.content.size - 1)).toBe(true)
  })

  it("returns true when the backtick appears mid-word", () => {
    const state = stateWithParagraph("x`foo_bar")
    expect(isInBacktickWord(state, state.doc.content.size - 1)).toBe(true)
  })

  it("returns false after whitespace breaks the backtick word", () => {
    // `f _name_ — the cursor at the end sits in a new word that no longer
    // contains a backtick.
    const state = stateWithParagraph("`f _name_")
    expect(isInBacktickWord(state, state.doc.content.size - 1)).toBe(false)
  })

  it("returns false for a brand-new word after any prior backtick", () => {
    const state = stateWithParagraph("`foo bar")
    // At the end of "bar" — prior word had the backtick, current word does not.
    expect(isInBacktickWord(state, state.doc.content.size - 1)).toBe(false)
  })

  it("uses ResolvedPos API directly", () => {
    const state = stateWithParagraph("`abc")
    const $pos = state.doc.resolve(state.doc.content.size - 1)
    expect(currentWordContainsBacktick($pos)).toBe(true)
  })

  it("treats a hard break as whitespace that resets the word", () => {
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [schema.text("`foo"), schema.nodes.hardBreak.create(), schema.text("_bar")]),
    ])
    const state = EditorState.create({ doc, schema })
    // Cursor at end of "_bar".
    expect(isInBacktickWord(state, state.doc.content.size - 1)).toBe(false)
  })

  it("does not treat an atom node as whitespace", () => {
    // `@ariadne_foo — the atom continues the backtick-owned word.
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [
        schema.text("`"),
        schema.nodes.mention.create({ slug: "ariadne" }),
        schema.text("_foo"),
      ]),
    ])
    const state = EditorState.create({ doc, schema })
    expect(isInBacktickWord(state, state.doc.content.size - 1)).toBe(true)
  })

  it("treats Unicode whitespace (non-breaking space) as a word break", () => {
    const state = stateWithParagraph("`foo\u00a0_bar")
    expect(isInBacktickWord(state, state.doc.content.size - 1)).toBe(false)
  })
})

describe("getParentTextBefore", () => {
  it("returns parent text from block start to the cursor offset", () => {
    const state = stateWithParagraph("hello world")
    // Resolve at position 7 → after "hello " (6 chars) inside paragraph
    const $pos = state.doc.resolve(7)
    expect(getParentTextBefore($pos)).toBe("hello ")
  })

  it("returns an empty string when the cursor is at block start", () => {
    const state = stateWithParagraph("hello")
    const $pos = state.doc.resolve(1)
    expect(getParentTextBefore($pos)).toBe("")
  })

  it("replaces atom leaf nodes with U+FFFC so adjacent text doesn't collapse", () => {
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [
        schema.text("hi "),
        schema.nodes.mention.create({ slug: "ariadne" }),
        schema.text(" there"),
      ]),
    ])
    const state = EditorState.create({ doc, schema })
    // Cursor at end of paragraph content.
    const $pos = state.doc.resolve(state.doc.content.size - 1)
    expect(getParentTextBefore($pos)).toBe("hi \ufffc there")
  })
})
