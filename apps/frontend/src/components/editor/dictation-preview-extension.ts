import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

export const DictationPreviewPluginKey = new PluginKey<string>("dictationPreview")

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
      new Plugin<string>({
        key: DictationPreviewPluginKey,
        state: {
          init: () => "",
          apply(tr, value) {
            const meta = tr.getMeta(DictationPreviewPluginKey)
            return typeof meta === "string" ? meta : value
          },
        },
        props: {
          decorations(state) {
            const text = DictationPreviewPluginKey.getState(state)
            if (!text) return null
            const widget = Decoration.widget(
              state.selection.to,
              () => {
                const span = document.createElement("span")
                span.className = "dictation-preview-ghost"
                span.textContent = text
                return span
              },
              // side:1 keeps the ghost after the caret; ignoreSelection stops it
              // from being treated as a selectable boundary. The text in the key
              // forces a fresh node when the hypothesis grows.
              { side: 1, ignoreSelection: true, key: `dictation-${text}` }
            )
            return DecorationSet.create(state.doc, [widget])
          },
        },
      }),
    ]
  },
})
