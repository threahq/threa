import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

interface DictationPreviewState {
  /** Full in-flight hypothesis for the current segment. */
  text: string
  /**
   * Character offset where the latest partial diverges from the previous one.
   * Text before this is unchanged from the prior frame (rendered instantly);
   * text from here on is freshly arrived (faded in) so growing partials read as
   * words materializing rather than the whole line repainting each update.
   */
  freshFrom: number
}

export const DictationPreviewPluginKey = new PluginKey<DictationPreviewState>("dictationPreview")

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    dictationPreview: {
      /** Show live (uncommitted) dictation text as a caret-anchored ghost; empty string clears it. */
      setDictationPreview: (text: string) => ReturnType
    }
  }
}

/**
 * Renders the in-flight dictation hypothesis as a non-editable ghost span at the
 * caret while the user is speaking, so words appear immediately instead of only
 * after the upstream VAD commits a segment. It is a view-only decoration: it
 * never touches the document, so it adds nothing to undo history and is inert
 * (decorations() returns null) whenever no preview text is set — i.e. for every
 * editor surface that isn't actively dictating.
 */
export const DictationPreview = Extension.create({
  name: "dictationPreview",

  addCommands() {
    return {
      setDictationPreview:
        (text: string) =>
        ({ tr, dispatch }) => {
          dispatch?.(tr.setMeta(DictationPreviewPluginKey, text))
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DictationPreviewState>({
        key: DictationPreviewPluginKey,
        state: {
          init: () => ({ text: "", freshFrom: 0 }),
          apply(tr, value) {
            const meta = tr.getMeta(DictationPreviewPluginKey)
            if (typeof meta !== "string" || meta === value.text) return value
            return { text: meta, freshFrom: commonPrefixLength(value.text, meta) }
          },
        },
        props: {
          decorations(state) {
            const preview = DictationPreviewPluginKey.getState(state)
            if (!preview?.text) return null
            const { text, freshFrom } = preview
            const widget = Decoration.widget(
              state.selection.to,
              () => {
                const span = document.createElement("span")
                span.className = "dictation-preview-ghost"
                // Carry-over text from the previous partial paints instantly; the
                // newly-arrived tail fades in (see .dictation-preview-ghost__fresh)
                // so the line grows word-by-word instead of repainting wholesale.
                const settled = text.slice(0, freshFrom)
                const fresh = text.slice(freshFrom)
                if (settled) span.append(settled)
                if (fresh) {
                  const freshSpan = document.createElement("span")
                  freshSpan.className = "dictation-preview-ghost__fresh"
                  freshSpan.textContent = fresh
                  span.appendChild(freshSpan)
                }
                return span
              },
              // side:1 keeps the ghost after the caret; ignoreSelection stops it
              // from being treated as a selectable boundary. The text in the key
              // forces a fresh node when the hypothesis grows, replaying the
              // fade on the new tail.
              { side: 1, ignoreSelection: true, key: `dictation-${text}` }
            )
            return DecorationSet.create(state.doc, [widget])
          },
        },
      }),
    ]
  },
})
