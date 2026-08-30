import { Extension } from "@tiptap/core"
import type { EditorState, Transaction } from "@tiptap/pm/state"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

export interface HeldRange {
  from: number
  to: number
}

type HeldMeta = { hold: HeldRange } | { release: true } | { keep: true }

export const HeldSelectionPluginKey = new PluginKey<HeldRange | null>("heldSelection")

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    heldSelection: {
      /** Collapse the native selection and keep its range for the format commands. False when nothing is selected. */
      holdSelection: () => ReturnType
      /** Select the held range so the next command in the chain applies to it; no-op when nothing is held. */
      selectHeld: () => ReturnType
      /** Collapse back to the end of the held range after a command; no-op when nothing is held. */
      collapseToHeld: () => ReturnType
      releaseHeld: () => ReturnType
    }
  }
}

export function heldRange(state: EditorState): HeldRange | null {
  return HeldSelectionPluginKey.getState(state) ?? null
}

function mapHeld(held: HeldRange, tr: Transaction): HeldRange | null {
  const from = tr.mapping.map(held.from, 1)
  const to = tr.mapping.map(held.to, -1)
  return to > from ? { from, to } : null
}

/**
 * A range the editor holds on to while the native selection is collapsed.
 *
 * On a phone the OS floats its own toolbar over any non-empty selection, on top
 * of whatever formatting chrome we place near the text. Holding the selection
 * collapses the DOM selection (which dismisses that toolbar) without blurring
 * (which would drop the keyboard); the held range is painted as a decoration
 * and the toolbar's commands wrap themselves in `selectHeld` /
 * `collapseToHeld` so the marks land on it. The range follows edits through
 * the transaction mapping and clears itself once it collapses, or when the
 * user moves the selection themselves (a tap places the caret, a long-press
 * selects new text): the visible selection is the target again. Our own
 * commands stamp their selection changes so they never count as the user's.
 */
export const HeldSelectionExtension = Extension.create({
  name: "heldSelection",

  addCommands() {
    return {
      holdSelection:
        () =>
        ({ state, tr, dispatch }) => {
          const { from, to } = state.selection
          if (from === to) return false
          if (dispatch) {
            tr.setMeta(HeldSelectionPluginKey, { hold: { from, to } } satisfies HeldMeta)
            tr.setSelection(TextSelection.create(tr.doc, to))
          }
          return true
        },
      selectHeld:
        () =>
        ({ state, tr, dispatch }) => {
          const held = heldRange(state)
          if (!held) return true
          if (dispatch) {
            tr.setMeta(HeldSelectionPluginKey, { keep: true } satisfies HeldMeta)
            tr.setSelection(TextSelection.create(tr.doc, held.from, held.to))
          }
          return true
        },
      collapseToHeld:
        () =>
        ({ state, tr, dispatch }) => {
          const held = heldRange(state)
          if (!held) return true
          if (dispatch) {
            const mapped = mapHeld(held, tr)
            tr.setMeta(HeldSelectionPluginKey, { keep: true } satisfies HeldMeta)
            tr.setSelection(TextSelection.create(tr.doc, mapped ? mapped.to : tr.selection.to))
          }
          return true
        },
      releaseHeld:
        () =>
        ({ state, tr, dispatch }) => {
          if (!heldRange(state)) return true
          if (dispatch) tr.setMeta(HeldSelectionPluginKey, { release: true } satisfies HeldMeta)
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<HeldRange | null>({
        key: HeldSelectionPluginKey,
        state: {
          init: () => null,
          apply(tr, held) {
            const meta = tr.getMeta(HeldSelectionPluginKey) as HeldMeta | undefined
            if (meta && "hold" in meta) return meta.hold
            if (meta && "release" in meta) return null
            if (!held) return null
            if (tr.docChanged) return mapHeld(held, tr)
            const userMoved = tr.selectionSet && !meta && (!tr.selection.empty || tr.getMeta("pointer") === true)
            return userMoved ? null : held
          },
        },
        props: {
          decorations(state) {
            const held = heldRange(state)
            if (!held) return null
            return DecorationSet.create(state.doc, [Decoration.inline(held.from, held.to, { class: "held-selection" })])
          },
        },
      }),
    ]
  },
})
