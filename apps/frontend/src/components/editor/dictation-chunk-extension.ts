import { Extension } from "@tiptap/core"
import { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { JSONContent } from "@threa/types"
import { canonicalContentSlice } from "./multiline-blocks"

export interface DictationChunkInfo {
  chunkId: string
  from: number
  to: number
  contentJson: JSONContent
}

type Chunk = { chunkId: string; from: number; to: number; expectedContentJson: JSONContent; locked: boolean }
type ChunkState = Map<string, Chunk>
type ChunkMeta = { type: "set"; chunk: Chunk } | { type: "lock"; chunkId: string } | { type: "removeAll" }

const DictationChunkPluginKey = new PluginKey<ChunkState>("dictationChunk")

function sliceJson(doc: ProseMirrorNode, from: number, to: number): JSONContent {
  return { type: "doc", content: doc.slice(from, to).content.toJSON() as JSONContent[] }
}

function equalJson(a: JSONContent, b: JSONContent): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function withBoundarySpace(state: EditorState, from: number, contentJson: JSONContent): JSONContent {
  const content = contentJson.content
  if (!content?.length || content[0].type !== "paragraph") return contentJson
  const charBefore = from > 0 ? state.doc.textBetween(from - 1, from) : ""
  if (!charBefore || /\s/.test(charBefore)) return contentJson
  const first = content[0]
  return {
    ...contentJson,
    content: [{ ...first, content: [{ type: "text", text: " " }, ...(first.content ?? [])] }, ...content.slice(1)],
  }
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    dictationChunk: {
      insertDictationChunk: (args: { chunkId: string; contentJson: JSONContent }) => ReturnType
      replaceDictationChunk: (args: { chunkId: string; contentJson: JSONContent }) => ReturnType
      lockDictationChunk: (args: { chunkId: string }) => ReturnType
      lockAllDictationChunks: () => ReturnType
    }
  }
}

export const DictationChunkExtension = Extension.create({
  name: "dictationChunk",

  addCommands() {
    return {
      insertDictationChunk:
        ({ chunkId, contentJson }) =>
        ({ state, tr, dispatch }) => {
          const existing = DictationChunkPluginKey.getState(state)?.get(chunkId)
          if (existing?.locked) return false
          const from = existing?.to ?? state.selection.from
          const to = existing?.to ?? state.selection.to
          const normalized = withBoundarySpace(state, from, contentJson)
          const slice = canonicalContentSlice(state.schema, normalized)
          if (!slice) return false
          tr.replaceRange(from, to, slice)
          const insertedFrom = tr.mapping.map(from, -1)
          const insertedTo = tr.mapping.map(to, 1)
          const chunkFrom = existing?.from ?? insertedFrom
          tr.setMeta(DictationChunkPluginKey, {
            type: "set",
            chunk: {
              chunkId,
              from: chunkFrom,
              to: insertedTo,
              expectedContentJson: sliceJson(tr.doc, chunkFrom, insertedTo),
              locked: false,
            },
          } satisfies ChunkMeta)
          dispatch?.(tr.scrollIntoView())
          return true
        },

      replaceDictationChunk:
        ({ chunkId, contentJson }) =>
        ({ state, tr, dispatch }) => {
          const chunk = DictationChunkPluginKey.getState(state)?.get(chunkId)
          if (!chunk || chunk.locked) return false
          const normalized = withBoundarySpace(state, chunk.from, contentJson)
          const slice = canonicalContentSlice(state.schema, normalized)
          if (!slice) return false
          if (!equalJson(sliceJson(state.doc, chunk.from, chunk.to), chunk.expectedContentJson)) {
            tr.setMeta(DictationChunkPluginKey, { type: "lock", chunkId } satisfies ChunkMeta)
            dispatch?.(tr)
            return false
          }
          tr.replaceRange(chunk.from, chunk.to, slice)
          const from = tr.mapping.map(chunk.from, -1)
          const to = tr.mapping.map(chunk.to, 1)
          tr.setMeta(DictationChunkPluginKey, {
            type: "set",
            chunk: { chunkId, from, to, expectedContentJson: sliceJson(tr.doc, from, to), locked: false },
          } satisfies ChunkMeta)
          dispatch?.(tr)
          return true
        },

      lockDictationChunk:
        ({ chunkId }) =>
        ({ tr, dispatch }) => {
          tr.setMeta(DictationChunkPluginKey, { type: "lock", chunkId } satisfies ChunkMeta)
          dispatch?.(tr)
          return true
        },

      lockAllDictationChunks:
        () =>
        ({ tr, dispatch }) => {
          tr.setMeta(DictationChunkPluginKey, { type: "removeAll" } satisfies ChunkMeta)
          dispatch?.(tr)
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<ChunkState>({
        key: DictationChunkPluginKey,
        state: {
          init: () => new Map(),
          apply(tr, previous) {
            const meta = tr.getMeta(DictationChunkPluginKey) as ChunkMeta | undefined
            if (meta?.type === "removeAll") return new Map()
            const next = new Map<string, Chunk>()
            for (const [id, chunk] of previous) {
              if (meta?.type === "set" && meta.chunk.chunkId === id) continue
              const from = tr.mapping.map(chunk.from, 1)
              const to = tr.mapping.map(chunk.to, -1)
              let locked = chunk.locked || (meta?.type === "lock" && meta.chunkId === id)
              if (tr.docChanged && !meta && !locked) {
                locked = from >= to || !equalJson(sliceJson(tr.doc, from, to), chunk.expectedContentJson)
              }
              next.set(id, { ...chunk, from, to: Math.max(from, to), locked })
            }
            if (meta?.type === "set") next.set(meta.chunk.chunkId, meta.chunk)
            return next
          },
        },
        props: {
          decorations(state) {
            const chunks = DictationChunkPluginKey.getState(state)
            if (!chunks?.size) return null
            return DecorationSet.create(
              state.doc,
              [...chunks.values()]
                .filter((chunk) => !chunk.locked && chunk.from < chunk.to)
                .map((chunk) =>
                  Decoration.inline(
                    chunk.from,
                    chunk.to,
                    { class: "dictation-chunk", "data-chunk-id": chunk.chunkId },
                    { inclusiveStart: false, inclusiveEnd: false }
                  )
                )
            )
          },
        },
      }),
    ]
  },
})

export function getDictationChunkPositions(state: EditorState): DictationChunkInfo[] {
  return [...(DictationChunkPluginKey.getState(state)?.values() ?? [])]
    .filter((chunk) => !chunk.locked)
    .map((chunk) => ({
      chunkId: chunk.chunkId,
      from: chunk.from,
      to: chunk.to,
      contentJson: sliceJson(state.doc, chunk.from, chunk.to),
    }))
}
