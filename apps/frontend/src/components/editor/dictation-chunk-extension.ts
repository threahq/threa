import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

export interface DictationChunkInfo {
  chunkId: string
  from: number
  to: number
  /** Text currently sitting inside the chunk range (read from the live doc). */
  text: string
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    dictationChunk: {
      /**
       * Insert a polished dictation chunk at the caret, prefixing with a single
       * space when the preceding character isn't whitespace (mirrors
       * insertTranscribedText). The inserted range is wrapped in a tracking
       * decoration that auto-maps through later edits, so it can be found and
       * replaced when the user toggles "Show original".
       */
      insertDictationChunk: (args: { chunkId: string; text: string }) => ReturnType
      /**
       * Replace the text inside a chunk with `newText`, but only if the chunk's
       * current text still matches `expectedText`. If the user has edited inside
       * the chunk (current text differs), the chunk is locked instead (its
       * decoration is removed) and the swap is skipped — the user's edit wins.
       */
      replaceDictationChunkText: (args: { chunkId: string; newText: string; expectedText: string }) => ReturnType
      /** Drop the tracking decoration for one chunk; its text stays in the doc. */
      lockDictationChunk: (args: { chunkId: string }) => ReturnType
      /** Drop tracking decorations for every chunk. */
      lockAllDictationChunks: () => ReturnType
    }
  }
}

type ChunkSpec = { chunkId: string }

type ChunkMeta =
  | { type: "add"; chunkId: string; from: number; to: number }
  | { type: "remove"; chunkId: string }
  | { type: "removeAll" }
  | { type: "replace"; chunkId: string; from: number; to: number }

const DictationChunkPluginKey = new PluginKey<DecorationSet>("dictationChunk")

function isChunkSpec(spec: unknown): spec is ChunkSpec {
  return typeof spec === "object" && spec !== null && typeof (spec as ChunkSpec).chunkId === "string"
}

function findChunk(set: DecorationSet, chunkId: string): Decoration | null {
  const decos = set.find(undefined, undefined, (spec) => isChunkSpec(spec) && spec.chunkId === chunkId)
  return decos[0] ?? null
}

function chunkDecoration(from: number, to: number, chunkId: string): Decoration {
  // Non-inclusive on both sides: typing right at the chunk's boundary lands
  // outside the chunk, so post-chunk edits don't extend the tracked range.
  return Decoration.inline(
    from,
    to,
    { class: "dictation-chunk", "data-chunk-id": chunkId },
    { chunkId, inclusiveStart: false, inclusiveEnd: false }
  )
}

/**
 * Tracks ranges of inserted polished dictation chunks so the session toggle can
 * later swap them between polished and raw text. The tracking is decoration-
 * only: chunk metadata never enters the document JSON, so it doesn't serialize
 * to markdown, doesn't survive a send, and doesn't leak into other surfaces.
 */
export const DictationChunkExtension = Extension.create({
  name: "dictationChunk",

  addCommands() {
    return {
      insertDictationChunk:
        ({ chunkId, text }) =>
        ({ state, tr, dispatch }) => {
          if (!text) return false
          const from = state.selection.from
          const charBefore = from > 0 ? state.doc.textBetween(from - 1, from) : ""
          const prefix = charBefore && !/\s/.test(charBefore) ? " " : ""
          const inserted = `${prefix}${text}`
          tr.insertText(inserted, from)
          const chunkFrom = from + prefix.length
          const chunkTo = from + inserted.length
          tr.setMeta(DictationChunkPluginKey, {
            type: "add",
            chunkId,
            from: chunkFrom,
            to: chunkTo,
          } satisfies ChunkMeta)
          if (dispatch) dispatch(tr.scrollIntoView())
          return true
        },

      replaceDictationChunkText:
        ({ chunkId, newText, expectedText }) =>
        ({ state, tr, dispatch }) => {
          const set = DictationChunkPluginKey.getState(state)
          if (!set) return false
          const deco = findChunk(set, chunkId)
          if (!deco) return false
          const currentText = state.doc.textBetween(deco.from, deco.to)
          if (currentText !== expectedText) {
            // The user edited inside the chunk between renders — preserve their
            // edit rather than overwriting it, and stop tracking this chunk so
            // a later toggle never resurrects the lost text.
            tr.setMeta(DictationChunkPluginKey, { type: "remove", chunkId } satisfies ChunkMeta)
            if (dispatch) dispatch(tr)
            return false
          }
          if (!newText) {
            tr.delete(deco.from, deco.to)
            tr.setMeta(DictationChunkPluginKey, { type: "remove", chunkId } satisfies ChunkMeta)
            if (dispatch) dispatch(tr)
            return true
          }
          const newFrom = deco.from
          const newTo = newFrom + newText.length
          tr.insertText(newText, deco.from, deco.to)
          // The "replace" meta below is applied AFTER the doc-change mapping,
          // so the plugin can re-anchor the decoration at the new bounds even
          // if mapping collapsed the original range.
          tr.setMeta(DictationChunkPluginKey, {
            type: "replace",
            chunkId,
            from: newFrom,
            to: newTo,
          } satisfies ChunkMeta)
          if (dispatch) dispatch(tr)
          return true
        },

      lockDictationChunk:
        ({ chunkId }) =>
        ({ tr, dispatch }) => {
          tr.setMeta(DictationChunkPluginKey, { type: "remove", chunkId } satisfies ChunkMeta)
          if (dispatch) dispatch(tr)
          return true
        },

      lockAllDictationChunks:
        () =>
        ({ tr, dispatch }) => {
          tr.setMeta(DictationChunkPluginKey, { type: "removeAll" } satisfies ChunkMeta)
          if (dispatch) dispatch(tr)
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: DictationChunkPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, oldSet) {
            // Map existing chunk ranges through the doc change before applying
            // explicit meta operations — that way add/remove always work on
            // up-to-date ranges.
            let set = oldSet.map(tr.mapping, tr.doc)
            const meta = tr.getMeta(DictationChunkPluginKey) as ChunkMeta | undefined
            if (!meta) return set
            if (meta.type === "add") {
              set = set.add(tr.doc, [chunkDecoration(meta.from, meta.to, meta.chunkId)])
              return set
            }
            if (meta.type === "remove") {
              const existing = findChunk(set, meta.chunkId)
              if (existing) set = set.remove([existing])
              return set
            }
            if (meta.type === "removeAll") {
              return DecorationSet.empty
            }
            if (meta.type === "replace") {
              // The range may or may not still exist after mapping; remove it
              // explicitly so we never end up with two decorations for the same
              // chunkId, then add the new tracked range.
              const existing = findChunk(set, meta.chunkId)
              if (existing) set = set.remove([existing])
              set = set.add(tr.doc, [chunkDecoration(meta.from, meta.to, meta.chunkId)])
              return set
            }
            return set
          },
        },
        props: {
          decorations(state) {
            const set = DictationChunkPluginKey.getState(state)
            return set && set !== DecorationSet.empty ? set : null
          },
        },
      }),
    ]
  },
})

/**
 * Snapshot the current chunk positions + the text sitting inside each one.
 * Callers (the dictation hook) use this to verify a chunk's text hasn't
 * drifted before issuing a swap.
 */
export function getDictationChunkPositions(state: EditorState): DictationChunkInfo[] {
  const set = DictationChunkPluginKey.getState(state)
  if (!set) return []
  return set
    .find()
    .filter((d) => isChunkSpec(d.spec))
    .map((d) => ({
      chunkId: (d.spec as ChunkSpec).chunkId,
      from: d.from,
      to: d.to,
      text: state.doc.textBetween(d.from, d.to),
    }))
}
