import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Mapping, StepMap } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { stringifyTokenStyle } from "shiki"
import { PLAINTEXT_LANGUAGE_ID, normalizeCodeLanguage } from "@threahq/types"
import { loadCodeLanguage, tryTokenizeSync } from "@/lib/markdown/highlighter"

const LANGUAGE_LOADED = "languageLoaded"

// Tokenizing is synchronous and reruns on every keystroke in the block; past
// this size a keystroke would stall typing, so the block stays plain.
const MAX_HIGHLIGHT_CHARS = 20_000

export const codeBlockHighlightKey = new PluginKey<DecorationSet>("codeBlockHighlight")

/**
 * The range two documents differ in, as a mapping. y-prosemirror applies every
 * remote change as one whole-document replace, so the transaction's own mapping
 * would drop every decoration; diffing keeps untouched blocks' decorations.
 */
function diffRange(before: ProseMirrorNode, after: ProseMirrorNode): { from: number; to: number; mapping: Mapping } {
  const start = before.content.findDiffStart(after.content)
  if (start === null) return { from: 0, to: 0, mapping: new Mapping() }
  let { a: endBefore, b: endAfter } = before.content.findDiffEnd(after.content)!
  const overlap = start - Math.min(endBefore, endAfter)
  if (overlap > 0) {
    endBefore += overlap
    endAfter += overlap
  }
  return {
    from: start,
    to: endAfter,
    mapping: new Mapping([new StepMap([start, endBefore - start, endAfter - start])]),
  }
}

/**
 * Colours code blocks with the Shiki themes posted messages use. Decorations
 * only carry `--shiki-light` / `--shiki-dark`; the `.shiki` rules in index.css
 * pick between them, so a draft and its sent message look the same.
 */
export function codeBlockHighlightPlugin(nodeName: string): Plugin<DecorationSet> {
  // Each language is loaded at most once per editor: a failed or unknown one stays plain.
  const requested = new Set<string>()
  let view: EditorView | null = null

  function requestLanguage(language: string) {
    if (requested.has(language)) return
    requested.add(language)
    void loadCodeLanguage(language).then((loaded) => {
      if (loaded && view) view.dispatch(view.state.tr.setMeta(codeBlockHighlightKey, LANGUAGE_LOADED))
    })
  }

  function blockDecorations(node: ProseMirrorNode, pos: number): Decoration[] {
    const language = normalizeCodeLanguage(node.attrs.language as string | null)
    const code = node.textContent
    if (language === PLAINTEXT_LANGUAGE_ID || code === "" || code.length > MAX_HIGHLIGHT_CHARS) return []
    const lines = tryTokenizeSync(code, language)
    if (!lines) {
      requestLanguage(language)
      return []
    }
    return lines.flat().flatMap((token) => {
      const style = token.htmlStyle ? stringifyTokenStyle(token.htmlStyle) : ""
      const from = pos + 1 + token.offset
      return style ? [Decoration.inline(from, from + token.content.length, { style })] : []
    })
  }

  // Re-decorates every textblock overlapping [from, to]; the rest keep their decoration objects.
  function redecorate(set: DecorationSet, doc: ProseMirrorNode, from: number, to: number): DecorationSet {
    const stale: Decoration[] = []
    const fresh: Decoration[] = []
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true
      stale.push(...set.find(pos, pos + node.nodeSize))
      if (node.type.name === nodeName) fresh.push(...blockDecorations(node, pos))
      return false
    })
    return set.remove(stale).add(doc, fresh)
  }

  return new Plugin<DecorationSet>({
    key: codeBlockHighlightKey,
    state: {
      init: (_config, state) => redecorate(DecorationSet.empty, state.doc, 0, state.doc.content.size),
      apply(tr, decorations) {
        if (tr.getMeta(codeBlockHighlightKey) === LANGUAGE_LOADED) {
          return redecorate(decorations, tr.doc, 0, tr.doc.content.size)
        }
        if (!tr.docChanged) return decorations
        const { from, to, mapping } = diffRange(tr.before, tr.doc)
        return redecorate(decorations.map(mapping, tr.doc), tr.doc, from, to)
      },
    },
    props: {
      decorations: (state) => codeBlockHighlightKey.getState(state),
    },
    view(editorView) {
      view = editorView
      return {
        destroy() {
          view = null
        },
      }
    },
  })
}
