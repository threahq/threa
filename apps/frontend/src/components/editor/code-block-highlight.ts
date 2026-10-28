import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { stringifyTokenStyle } from "shiki"
import { PLAINTEXT_LANGUAGE_ID, normalizeCodeLanguage } from "@threahq/types"
import { loadCodeLanguage, tryTokenizeSync } from "@/lib/markdown/highlighter"

interface TokenSpan {
  from: number
  to: number
  style: string
}

const LANGUAGE_LOADED = "languageLoaded"

const codeBlockHighlightKey = new PluginKey<DecorationSet>("codeBlockHighlight")

/** Ranges a transaction rewrote, in the coordinates of its resulting document. */
function changedRanges(tr: Transaction): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  tr.mapping.maps.forEach((map, index) => {
    const later = tr.mapping.slice(index + 1)
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push([later.map(newStart, -1), later.map(newEnd, 1)])
    })
  })
  return ranges
}

/**
 * Colours code blocks with the Shiki themes posted messages use. Decorations
 * only carry `--shiki-light` / `--shiki-dark`; the `.shiki` rules in index.css
 * pick between them, so a draft and its sent message look the same.
 */
export function codeBlockHighlightPlugin(nodeName: string): Plugin<DecorationSet> {
  // Rebuilt each pass from the blocks still present, so it never outgrows the document.
  let spansByBlock = new Map<string, TokenSpan[]>()
  const loading = new Set<string>()
  let view: EditorView | null = null

  function requestLanguage(language: string) {
    if (loading.has(language)) return
    loading.add(language)
    void loadCodeLanguage(language).then((loaded) => {
      loading.delete(language)
      // Only a real load re-decorates: an unknown language stays plain instead of looping.
      if (loaded && view) view.dispatch(view.state.tr.setMeta(codeBlockHighlightKey, LANGUAGE_LOADED))
    })
  }

  function tokenSpans(code: string, language: string): TokenSpan[] | null {
    const lines = tryTokenizeSync(code, language)
    if (!lines) return null
    return lines.flat().flatMap((token) => {
      const style = token.htmlStyle ? stringifyTokenStyle(token.htmlStyle) : ""
      return style ? [{ from: token.offset, to: token.offset + token.content.length, style }] : []
    })
  }

  function decorate(doc: ProseMirrorNode): DecorationSet {
    const previous = spansByBlock
    spansByBlock = new Map()
    const decorations: Decoration[] = []
    doc.descendants((node, pos) => {
      if (node.type.name !== nodeName) return !node.isTextblock
      const language = normalizeCodeLanguage(node.attrs.language as string | null)
      if (language === PLAINTEXT_LANGUAGE_ID || node.textContent === "") return false
      const key = `${language}\n${node.textContent}`
      const spans = spansByBlock.get(key) ?? previous.get(key) ?? tokenSpans(node.textContent, language)
      if (!spans) {
        requestLanguage(language)
        return false
      }
      spansByBlock.set(key, spans)
      for (const span of spans) {
        decorations.push(Decoration.inline(pos + 1 + span.from, pos + 1 + span.to, { style: span.style }))
      }
      return false
    })
    return DecorationSet.create(doc, decorations)
  }

  return new Plugin<DecorationSet>({
    key: codeBlockHighlightKey,
    state: {
      init: (_config, state) => decorate(state.doc),
      apply(tr, decorations) {
        if (tr.getMeta(codeBlockHighlightKey) === LANGUAGE_LOADED) return decorate(tr.doc)
        if (!tr.docChanged) return decorations
        const mapped = decorations.map(tr.mapping, tr.doc)
        // Edits outside every code block keep the mapped set; a block whose
        // text, language or type changed gets re-tokenized.
        const touchesCode = changedRanges(tr).some(([from, to]) => {
          if (mapped.find(from, to).length > 0) return true
          let found = false
          tr.doc.nodesBetween(Math.max(0, from - 1), Math.min(tr.doc.content.size, to + 1), (node) => {
            if (node.type.name === nodeName) found = true
            return !found && !node.isTextblock
          })
          return found
        })
        return touchesCode ? decorate(tr.doc) : mapped
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
