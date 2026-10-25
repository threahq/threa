/**
 * Custom mark extensions with atom-aware input rules.
 *
 * TipTap's default input rules for marks (bold, italic, code, strike) don't
 * handle atom nodes (like mentions) correctly. When you type **Hello @mention world**,
 * the standard input rule miscalculates positions and corrupts the content.
 *
 * These extensions replace the default input rules with atom-aware versions
 * that correctly walk the document structure.
 */

import { Bold } from "@tiptap/extension-bold"
import { Italic } from "@tiptap/extension-italic"
import { Strike } from "@tiptap/extension-strike"
import { ThreaCode } from "@threahq/prosemirror/schema"
import { atomAwareMarkInputRule } from "./atom-aware-input-rules"

/**
 * Bold extension with atom-aware input rules.
 * Typing **text** or __text__ converts to bold, even with mentions inside.
 */
export const AtomAwareBold = Bold.extend({
  addKeyboardShortcuts() {
    return {} // Formatting shortcuts handled by EditorBehaviors
  },
  addInputRules() {
    return [
      atomAwareMarkInputRule({
        openMarker: "**",
        closeMarker: "**",
        type: this.type,
      }),
      atomAwareMarkInputRule({
        openMarker: "__",
        closeMarker: "__",
        type: this.type,
      }),
    ]
  },
})

/**
 * Italic extension with atom-aware input rules.
 * Typing *text* or _text_ converts to italic, even with mentions inside.
 */
export const AtomAwareItalic = Italic.extend({
  addKeyboardShortcuts() {
    return {} // Formatting shortcuts handled by EditorBehaviors
  },
  addInputRules() {
    return [
      atomAwareMarkInputRule({
        openMarker: "*",
        closeMarker: "*",
        type: this.type,
      }),
      atomAwareMarkInputRule({
        openMarker: "_",
        closeMarker: "_",
        type: this.type,
      }),
    ]
  },
})

/**
 * Strike extension with atom-aware input rules.
 * Typing ~~text~~ converts to strikethrough, even with mentions inside.
 */
export const AtomAwareStrike = Strike.extend({
  addKeyboardShortcuts() {
    return {} // Formatting shortcuts handled by EditorBehaviors
  },
  addInputRules() {
    return [
      atomAwareMarkInputRule({
        openMarker: "~~",
        closeMarker: "~~",
        type: this.type,
      }),
    ]
  },
})

/**
 * Code extension with atom-aware input rules.
 * Typing `text` converts to inline code, even with mentions inside.
 * Mentions are converted to their text representation (e.g., @ariadne becomes plain text).
 *
 * The schema allows a link on code (markdown `[\`x\`](url)`), but applying code
 * in the composer drops links: a URL the autolinker caught before the closing
 * backtick is code text, not a link.
 */
export const AtomAwareCode = ThreaCode.extend({
  exitable: false,
  addKeyboardShortcuts() {
    return {} // Formatting shortcuts handled by EditorBehaviors
  },
  addCommands() {
    const parent = this.parent!()
    const parentToggleCode = parent.toggleCode!
    return {
      ...parent,
      toggleCode: () => (props) => {
        if (!props.editor.isActive(this.name)) props.commands.unsetMark("link")
        return parentToggleCode()(props)
      },
    }
  },
  addInputRules() {
    return [
      atomAwareMarkInputRule({
        openMarker: "`",
        closeMarker: "`",
        type: this.type,
        convertAtomsToText: true,
        dropMarks: ["link"],
      }),
    ]
  },
})
