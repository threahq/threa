import { Extension } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

export const BLOCK_HIGHLIGHT_MS = 1500
export const BLOCK_HIGHLIGHT_CLASS = "rounded-sm bg-primary/10 transition-colors"

const DocBlockLandingPluginKey = new PluginKey<string | null>("docBlockLanding")

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docBlockLanding: {
      /** Scroll to and briefly highlight the top-level block with this id; false when the doc has none. */
      landOnBlock: (blockId: string) => ReturnType
    }
  }
}

function findTopLevelBlock(doc: ProseMirrorNode, blockId: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  doc.forEach((node, offset) => {
    if (!found && node.attrs.blockId === blockId) found = { from: offset, to: offset + node.nodeSize }
  })
  return found
}

interface DocBlockLandingStorage {
  clearTimer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The plugin holds the block id, not positions: a remote Yjs sync can replace the whole doc, and the id still
 * resolves after it. A decoration, not a DOM class, because ProseMirror redraws a node whose attrs change.
 */
export const DocBlockLanding = Extension.create<object, DocBlockLandingStorage>({
  name: "docBlockLanding",

  addStorage() {
    return { clearTimer: undefined }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<string | null>({
        key: DocBlockLandingPluginKey,
        state: {
          init: () => null,
          apply: (tr, blockId) => {
            const meta = tr.getMeta(DocBlockLandingPluginKey) as string | null | undefined
            return meta === undefined ? blockId : meta
          },
        },
        props: {
          decorations: (state) => {
            const blockId = DocBlockLandingPluginKey.getState(state)
            const target = blockId ? findTopLevelBlock(state.doc, blockId) : null
            if (!target) return null
            return DecorationSet.create(state.doc, [
              Decoration.node(target.from, target.to, { class: BLOCK_HIGHLIGHT_CLASS }),
            ])
          },
        },
      }),
    ]
  },

  addCommands() {
    return {
      landOnBlock:
        (blockId) =>
        ({ state, tr, view, dispatch }) => {
          const target = findTopLevelBlock(state.doc, blockId)
          if (!target) return false
          if (!dispatch) return true
          tr.setMeta(DocBlockLandingPluginKey, blockId).setMeta("addToHistory", false)
          const dom = view.nodeDOM(target.from)
          if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "center" })
          clearTimeout(this.storage.clearTimer)
          this.storage.clearTimer = setTimeout(() => {
            const { editor } = this
            if (!editor.isDestroyed) {
              editor.view.dispatch(
                editor.state.tr.setMeta(DocBlockLandingPluginKey, null).setMeta("addToHistory", false)
              )
            }
          }, BLOCK_HIGHLIGHT_MS)
          return true
        },
    }
  },

  onDestroy() {
    clearTimeout(this.storage.clearTimer)
  },
})
