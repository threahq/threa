import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Mapping, StepMap } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { stringifyTokenStyle } from "shiki"
import { PLAINTEXT_LANGUAGE_ID, normalizeCodeLanguage } from "@threahq/types"
import { loadCodeLanguage, tryTokenizeSync } from "@/lib/markdown/highlighter"

const LANGUAGE_LOADED = "languageLoaded"
const FLUSH = "flush"

// Shiki tokenizes a 2k-char TypeScript block in ~25ms, so edits only map the
// decorations and the edited blocks are re-tokenized once typing pauses.
const HIGHLIGHT_DELAY_MS = 150

// Re-tokenizing scales with the block (~80ms at this size); past it a pause in
// typing would stall the next keystroke, so the block stays plain.
const MAX_HIGHLIGHT_CHARS = 10_000

interface HighlightState {
  decorations: DecorationSet
  /** The changed range still carrying mapped, not re-tokenized, decorations. */
  dirty: { from: number; to: number } | null
}

export const codeBlockHighlightKey = new PluginKey<HighlightState>("codeBlockHighlight")

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
export function codeBlockHighlightPlugin(nodeName: string): Plugin<HighlightState> {
  // Each language is loaded at most once per editor: a failed or unknown one stays plain.
  const requested = new Set<string>()
  let view: EditorView | null = null
  let flushTimer: ReturnType<typeof setTimeout> | undefined

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

  return new Plugin<HighlightState>({
    key: codeBlockHighlightKey,
    state: {
      init: (_config, state) => ({
        decorations: redecorate(DecorationSet.empty, state.doc, 0, state.doc.content.size),
        dirty: null,
      }),
      apply(tr, { decorations, dirty }) {
        const meta = tr.getMeta(codeBlockHighlightKey)
        if (meta === LANGUAGE_LOADED) {
          return { decorations: redecorate(decorations, tr.doc, 0, tr.doc.content.size), dirty: null }
        }
        if (meta === FLUSH && dirty) {
          return { decorations: redecorate(decorations, tr.doc, dirty.from, dirty.to), dirty: null }
        }
        if (!tr.docChanged) return { decorations, dirty }
        const { from, to, mapping } = diffRange(tr.before, tr.doc)
        const changed = dirty
          ? { from: Math.min(from, mapping.map(dirty.from, -1)), to: Math.max(to, mapping.map(dirty.to)) }
          : { from, to }
        return { decorations: decorations.map(mapping, tr.doc), dirty: changed }
      },
    },
    props: {
      decorations: (state) => codeBlockHighlightKey.getState(state)?.decorations,
    },
    view(editorView) {
      view = editorView
      return {
        update(updated, prevState) {
          const { dirty } = codeBlockHighlightKey.getState(updated.state)!
          if (!dirty || updated.state.doc === prevState.doc) return
          clearTimeout(flushTimer)
          flushTimer = setTimeout(() => {
            if (view) view.dispatch(view.state.tr.setMeta(codeBlockHighlightKey, FLUSH))
          }, HIGHLIGHT_DELAY_MS)
        },
        destroy() {
          clearTimeout(flushTimer)
          view = null
        },
      }
    },
  })
}
