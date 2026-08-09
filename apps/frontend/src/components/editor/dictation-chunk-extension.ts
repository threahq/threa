import { Extension } from "@tiptap/core"
import { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { JSONContent, VoiceReplacementAckStatus, VoiceTranscriptReplacementSourceV4 } from "@threa/types"
import { canonicalContentSlice } from "./multiline-blocks"

export interface DictationChunkInfo {
  chunkId: string
  from: number
  to: number
  contentJson: JSONContent
}

type Chunk = { chunkId: string; from: number; to: number; expectedContentJson: JSONContent; locked: boolean }
type ChunkState = Map<string, Chunk>
type ChunkMeta =
  | { type: "set"; chunk: Chunk; removeChunkIds?: string[] }
  | { type: "lock"; chunkId: string }
  | { type: "removeAll" }

const DictationChunkPluginKey = new PluginKey<ChunkState>("dictationChunk")

function sliceJson(doc: ProseMirrorNode, from: number, to: number): JSONContent {
  return { type: "doc", content: doc.slice(from, to).content.toJSON() as JSONContent[] }
}

function equalJson(a: JSONContent, b: JSONContent): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isCanonicalDoc(contentJson: unknown): contentJson is JSONContent {
  return (
    typeof contentJson === "object" &&
    contentJson !== null &&
    (contentJson as JSONContent).type === "doc" &&
    Array.isArray((contentJson as JSONContent).content) &&
    (contentJson as JSONContent).content!.length > 0
  )
}

function replacementSpan(
  tr: Transaction,
  firstStep: number,
  requestedFrom: number,
  requestedTo: number
): { from: number; to: number } | null {
  let oldFrom = requestedFrom
  let oldTo = requestedTo
  for (let index = firstStep; index < tr.steps.length; index++) {
    const map = tr.steps[index]!.getMap()
    let newFrom: number | undefined
    let newTo: number | undefined
    map.forEach((stepOldFrom, stepOldTo, stepNewFrom, stepNewTo) => {
      if (stepOldFrom <= oldFrom && stepOldTo >= oldTo && stepNewTo > stepNewFrom) {
        newFrom = stepNewFrom
        newTo = stepNewTo
      }
    })
    if (newFrom !== undefined && newTo !== undefined) {
      let from = newFrom
      let to = newTo
      for (let later = index + 1; later < tr.steps.length; later++) {
        const laterMap = tr.steps[later]!.getMap()
        from = laterMap.map(from, -1)
        to = laterMap.map(to, 1)
      }
      return from < to ? { from, to } : null
    }
    oldFrom = map.map(oldFrom, -1)
    oldTo = map.map(oldTo, 1)
  }
  return null
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
      insertDictationChunk: (args: {
        chunkId: string
        contentJson: JSONContent
        afterChunkId?: string
        joinPrevious?: boolean
      }) => ReturnType
      replaceDictationChunk: (args: { chunkId: string; contentJson: JSONContent }) => ReturnType
      replaceDictationChunks: (args: {
        sources: VoiceTranscriptReplacementSourceV4[]
        resultChunkId: string
        contentJson: JSONContent
        onResult: (status: VoiceReplacementAckStatus) => void
      }) => ReturnType
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
        ({ chunkId, contentJson, afterChunkId, joinPrevious }) =>
        ({ state, tr, dispatch }) => {
          const chunks = DictationChunkPluginKey.getState(state)
          const existing = chunks?.get(chunkId)
          const predecessor = afterChunkId ? chunks?.get(afterChunkId) : undefined
          if (afterChunkId && !predecessor) return false
          if (!isCanonicalDoc(contentJson)) return false
          const from = existing?.to ?? predecessor?.to ?? state.selection.from
          const to = existing?.to ?? predecessor?.to ?? state.selection.to
          const normalized = joinPrevious ? contentJson : withBoundarySpace(state, from, contentJson)
          const slice = canonicalContentSlice(state.schema, normalized)
          if (!slice) return false
          const firstStep = tr.steps.length
          tr.replaceRange(from, to, slice)
          const inserted = replacementSpan(tr, firstStep, from, to)
          if (!inserted) return false
          const chunkFrom = existing?.from ?? inserted.from
          const chunkTo = inserted.to
          if (chunkFrom >= chunkTo) return false
          tr.setMeta(DictationChunkPluginKey, {
            type: "set",
            chunk: {
              chunkId,
              from: chunkFrom,
              to: chunkTo,
              expectedContentJson: sliceJson(tr.doc, chunkFrom, chunkTo),
              locked: existing?.locked ?? false,
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
          if (!isCanonicalDoc(contentJson)) return false
          const normalized = withBoundarySpace(state, chunk.from, contentJson)
          const slice = canonicalContentSlice(state.schema, normalized)
          if (!slice) return false
          if (!equalJson(sliceJson(state.doc, chunk.from, chunk.to), chunk.expectedContentJson)) {
            tr.setMeta(DictationChunkPluginKey, { type: "lock", chunkId } satisfies ChunkMeta)
            dispatch?.(tr)
            return false
          }
          const firstStep = tr.steps.length
          tr.replaceRange(chunk.from, chunk.to, slice)
          const inserted = replacementSpan(tr, firstStep, chunk.from, chunk.to)
          if (!inserted) return false
          const { from, to } = inserted
          tr.setMeta(DictationChunkPluginKey, {
            type: "set",
            chunk: { chunkId, from, to, expectedContentJson: sliceJson(tr.doc, from, to), locked: false },
          } satisfies ChunkMeta)
          dispatch?.(tr)
          return true
        },

      replaceDictationChunks:
        ({ sources, resultChunkId, contentJson, onResult }) =>
        ({ state, tr, dispatch }) => {
          const finish = (status: VoiceReplacementAckStatus) => {
            onResult(status)
            return status === "applied"
          }
          if (
            !isCanonicalDoc(contentJson) ||
            typeof resultChunkId !== "string" ||
            resultChunkId.length === 0 ||
            !Array.isArray(sources) ||
            sources.length < 1 ||
            sources.length > 2 ||
            sources.some(
              (source) =>
                !source ||
                typeof source !== "object" ||
                typeof source.chunkId !== "string" ||
                source.chunkId.length === 0 ||
                !Number.isSafeInteger(source.throughRevision) ||
                source.throughRevision < 0
            ) ||
            new Set(sources.map((source) => source.chunkId)).size !== sources.length
          )
            return finish("invalid")
          const chunks = DictationChunkPluginKey.getState(state)
          if (chunks?.has(resultChunkId) && !sources.some((source) => source.chunkId === resultChunkId))
            return finish("invalid")
          const resolved = sources.map((source) => chunks?.get(source.chunkId))
          if (resolved.some((chunk) => !chunk)) return finish("missing")
          const concrete = resolved as Chunk[]
          const locked = concrete.find((chunk) => chunk.locked)
          if (locked) return finish("locked")
          for (const chunk of concrete) {
            if (!equalJson(sliceJson(state.doc, chunk.from, chunk.to), chunk.expectedContentJson)) {
              tr.setMeta(DictationChunkPluginKey, { type: "lock", chunkId: chunk.chunkId } satisfies ChunkMeta)
              dispatch?.(tr)
              return finish("locked")
            }
          }
          if (concrete.some((chunk, index) => index > 0 && concrete[index - 1].to !== chunk.from))
            return finish("non_contiguous")
          const first = concrete[0]
          const last = concrete.at(-1)!
          const normalized = withBoundarySpace(state, first.from, contentJson)
          const slice = canonicalContentSlice(state.schema, normalized)
          if (!slice) return finish("invalid")
          const firstStep = tr.steps.length
          tr.replaceRange(first.from, last.to, slice)
          const inserted = replacementSpan(tr, firstStep, first.from, last.to)
          if (!inserted) return finish("invalid")
          const { from, to } = inserted
          tr.setMeta(DictationChunkPluginKey, {
            type: "set",
            removeChunkIds: sources.map((source) => source.chunkId),
            chunk: {
              chunkId: resultChunkId,
              from,
              to,
              expectedContentJson: sliceJson(tr.doc, from, to),
              locked: false,
            },
          } satisfies ChunkMeta)
          dispatch?.(tr)
          return finish("applied")
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
              if (meta?.type === "set" && (meta.chunk.chunkId === id || meta.removeChunkIds?.includes(id))) continue
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
