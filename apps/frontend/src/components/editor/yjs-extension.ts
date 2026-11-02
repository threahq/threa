import { Extension } from "@tiptap/core"
import { DOC_FRAGMENT } from "@threahq/types"
import { Plugin, type EditorState } from "@tiptap/pm/state"
import type * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"
// The server applies and reads this fragment with the same pinned y-prosemirror
// (`apps/backend/src/features/docs/yjs.ts`); keep both on one exact version so
// the client writes the structure the server parses.
import {
  defaultCursorBuilder,
  redo,
  undo,
  yCursorPlugin,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
} from "y-prosemirror"

const localUserIdOf = (awareness: Awareness): string | undefined =>
  (awareness.getLocalState()?.user as { userId?: string } | undefined)?.userId

/** Peers' carets, drawn by y-prosemirror's default builder; the label is decoration, not document text. */
function caretPlugin(awareness: Awareness) {
  return yCursorPlugin(awareness, {
    // The viewer's other tabs are not peers in the header either.
    awarenessStateFilter: (localClientId: number, clientId: number, state: { user?: { userId?: string } }) => {
      const localUserId = localUserIdOf(awareness)
      return localClientId !== clientId && (localUserId === undefined || state.user?.userId !== localUserId)
    },
    cursorBuilder: (user) => {
      const caret = defaultCursorBuilder(user)
      caret.setAttribute("aria-hidden", "true")
      return caret
    },
  })
}

const sameCaret = (a: EditorState, b: EditorState): boolean =>
  a.selection.empty &&
  b.selection.empty &&
  a.selection.$head.parentOffset === b.selection.$head.parentOffset &&
  a.selection.$head.parent.textContent === b.selection.$head.parent.textContent

/**
 * y-prosemirror applies a remote update by replacing the whole document, which drops stored marks: bold toggled
 * before typing would turn off when the server's block-id update lands.
 */
function keepStoredMarksPlugin() {
  return new Plugin({
    appendTransaction: (transactions, oldState, newState) => {
      if (!oldState.storedMarks || newState.storedMarks || !sameCaret(oldState, newState)) return null
      if (!transactions.some((tr) => tr.getMeta(ySyncPluginKey)?.isChangeOrigin)) return null
      return newState.tr.setStoredMarks(oldState.storedMarks).setMeta("addToHistory", false)
    },
  })
}

const HISTORY_INPUT_COMMANDS: Partial<Record<string, typeof undo>> = { historyUndo: undo, historyRedo: redo }

interface YjsCollaborationOptions {
  ydoc: Y.Doc | null
  awareness: Awareness | null
}

export const YjsCollaboration = Extension.create<YjsCollaborationOptions>({
  name: "yjsCollaboration",

  addOptions() {
    return { ydoc: null, awareness: null }
  },

  addProseMirrorPlugins() {
    const { ydoc, awareness } = this.options
    if (!ydoc) throw new Error("YjsCollaboration needs the Y.Doc it binds to")
    return [
      ySyncPlugin(ydoc.getXmlFragment(DOC_FRAGMENT)),
      yUndoPlugin(),
      keepStoredMarksPlugin(),
      ...(awareness ? [caretPlugin(awareness)] : []),
      // Edit-menu, shake and keyboard undo arrive as beforeinput; the browser's own contenteditable undo would bypass Yjs.
      new Plugin({
        props: {
          handleDOMEvents: {
            beforeinput: (view, event) => {
              const command = HISTORY_INPUT_COMMANDS[event.inputType]
              if (!command) return false
              event.preventDefault()
              command(view.state)
              return true
            },
          },
        },
      }),
    ]
  },

  addKeyboardShortcuts() {
    return {
      "Mod-z": ({ editor }) => undo(editor.state),
      "Mod-y": ({ editor }) => redo(editor.state),
      "Shift-Mod-z": ({ editor }) => redo(editor.state),
    }
  },
})
