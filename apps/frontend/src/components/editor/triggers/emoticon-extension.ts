import { Extension, InputRule } from "@tiptap/core"
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state"
import { ReplaceStep } from "@tiptap/pm/transform"
import { isSuggestionActive } from "../editor-behaviors"
import { getParentTextBefore } from "../markdown-guards"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    emoticon: {
      /** Convert the emoticon ending at the caret, for input that ends without a space: a new line, a send. */
      commitEmoticon: () => ReturnType
    }
  }
}

type EmoticonLookup = (emoticon: string) => string | null

export interface EmoticonExtensionOptions {
  /** The emoji an emoticon converts to; null for any other text, and for all of it when conversion is off. */
  toEmoji: EmoticonLookup
}

interface EmoticonState {
  /** Start of the word the user pressed Escape on; an emoticon starting there stays text. */
  escaped: number | null
  /** Where the caret was left by the user's own typing, while it is still there. */
  typedEnd: number | null
}

const EmoticonPluginKey = new PluginKey<EmoticonState>("emoticon")

/**
 * Text the user typed, as opposed to a paste, an undo, loaded content or a
 * collaborator's edit. Only a word that ends in typing converts, so finishing a
 * line someone else wrote leaves their `:)` alone.
 */
function isTyping(tr: Transaction): boolean {
  if (tr.getMeta("paste") || tr.getMeta("uiEvent") || tr.getMeta("history$")) return false
  let inserted = false
  for (const step of tr.steps) {
    if (!(step instanceof ReplaceStep)) return false
    if (step.slice.content.content.some((node) => !node.isText)) return false
    inserted ||= step.slice.size > 0
  }
  return inserted
}

const SPACE = /[ \u00a0]/

/** One character per leaf, so text offsets stay document positions. */
function leafText(leaf: ProseMirrorNode): string {
  return leaf.type.name === "hardBreak" ? "\n" : "\ufffc"
}

function wordBefore($pos: ResolvedPos): { from: number; text: string } | null {
  const text = /\S+$/.exec($pos.parent.textBetween(0, $pos.parentOffset, undefined, leafText))?.[0]
  return text ? { from: $pos.pos - text.length, text } : null
}

function startsWord($pos: ResolvedPos): boolean {
  const { parent, parentOffset } = $pos
  const before = parent.textBetween(Math.max(0, parentOffset - 1), parentOffset, undefined, leafText)
  const after = parent.textBetween(parentOffset, Math.min(parent.content.size, parentOffset + 1), undefined, leafText)
  return !/\S/.test(before) && /\S/.test(after)
}

/**
 * The emoticon the user just typed as the whole word ending at `pos`, unless it
 * sits in code or was escaped.
 */
function emoticonBefore(
  state: EditorState,
  pos: number,
  toEmoji: EmoticonLookup
): { from: number; emoji: string } | null {
  const { escaped, typedEnd } = EmoticonPluginKey.getState(state) ?? { escaped: null, typedEnd: null }
  if (typedEnd !== state.selection.from) return null
  const $pos = state.doc.resolve(pos)
  if ($pos.parent.type.spec.code || $pos.marks().some((mark) => mark.type.spec.code)) return null
  // Inline code still being typed is plain text until its closing backtick.
  if ((getParentTextBefore($pos).split("`").length - 1) % 2 === 1) return null
  const word = wordBefore($pos)
  if (!word || word.from === escaped) return null
  const emoji = toEmoji(word.text)
  return emoji ? { from: word.from, emoji } : null
}

/**
 * Text emoticons become emoji once the word is finished: `:)` then a space, a
 * new line or a send. Waiting for the boundary is what lets `:p` go on to
 * become `:pray:`.
 *
 * Two ways back to the text: Backspace straight after a conversion undoes it,
 * and Escape while typing the word keeps it literal.
 */
export const EmoticonExtension = Extension.create<EmoticonExtensionOptions>({
  name: "emoticon",

  // Above EditorBehaviors, whose Enter keymap would otherwise take the key first.
  priority: 1001,

  addOptions() {
    return { toEmoji: () => null }
  },

  addCommands() {
    const { toEmoji } = this.options
    return {
      commitEmoticon:
        () =>
        ({ state, tr, dispatch }) => {
          if (!state.selection.empty) return false
          return replaceEmoticon(state, tr, state.selection.from, "", toEmoji, dispatch !== undefined)
        },
    }
  },

  addInputRules() {
    const { toEmoji } = this.options
    return [
      new InputRule({
        find: /\S[ \u00a0]$/,
        handler: ({ state, match }) => {
          if (!state.selection.empty) return null
          const caret = state.selection.from
          // A composition has already put the space in the document; a typed one is still on its way.
          const spaceInDoc = SPACE.test(state.doc.textBetween(Math.max(0, caret - 1), caret, "\n", leafText))
          const converted = spaceInDoc
            ? replaceEmoticon(state, state.tr, caret - 1, "", toEmoji, true)
            : replaceEmoticon(state, state.tr, caret, match[0].slice(-1), toEmoji, true)
          return converted ? undefined : null
        },
      }),
    ]
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const { toEmoji } = this.options
    return [
      new Plugin<EmoticonState>({
        key: EmoticonPluginKey,
        state: {
          init: () => ({ escaped: null, typedEnd: null }),
          apply(tr, { escaped, typedEnd }, _oldState, newState) {
            const caret = newState.selection.empty ? newState.selection.from : null
            if (tr.docChanged) typedEnd = isTyping(tr) ? caret : null
            else if (typedEnd !== caret) typedEnd = null

            const marked = tr.getMeta(EmoticonPluginKey) as number | undefined
            if (marked !== undefined) return { escaped: marked, typedEnd }
            if (escaped !== null && tr.docChanged) {
              const mapped = tr.mapping.mapResult(escaped, 1)
              escaped = !mapped.deleted && startsWord(newState.doc.resolve(mapped.pos)) ? mapped.pos : null
            }
            return { escaped, typedEnd }
          },
        },
        props: {
          handleKeyDown(view, event) {
            if (event.key === "Enter" && !event.isComposing && !isSuggestionActive(editor)) {
              editor.commands.commitEmoticon()
              return false
            }
            if (event.key !== "Escape" || !view.state.selection.empty) return false

            const caret = view.state.selection.from
            const word = wordBefore(view.state.doc.resolve(caret))
            if (!word) return false
            const pending = emoticonBefore(view.state, caret, toEmoji) !== null
            view.dispatch(view.state.tr.setMeta(EmoticonPluginKey, word.from))
            // An open picker still needs this Escape to close. With none, keeping
            // the emoticon is all the key does: it must not also blur the editor,
            // or reach a host listening on the document to cancel an edit.
            if (!pending || isSuggestionActive(editor)) return false
            event.preventDefault()
            event.stopPropagation()
            return true
          },
        },
      }),
    ]
  },
})

function replaceEmoticon(
  state: EditorState,
  tr: Transaction,
  pos: number,
  suffix: string,
  toEmoji: EmoticonLookup,
  apply: boolean
): boolean {
  const found = emoticonBefore(state, pos, toEmoji)
  if (!found) return false
  if (apply) tr.replaceWith(found.from, pos, state.schema.text(found.emoji + suffix, state.doc.resolve(pos).marks()))
  return true
}
