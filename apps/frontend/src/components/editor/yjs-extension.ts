import { Extension } from "@tiptap/core"
import { DOC_FRAGMENT } from "@threahq/types"
import { Plugin } from "@tiptap/pm/state"
import type * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"
// The server applies and reads this fragment with the same pinned y-prosemirror
// (`apps/backend/src/features/docs/yjs.ts`); keep both on one exact version so
// the client writes the structure the server parses.
import { redo, undo, yCursorPlugin, ySyncPlugin, yUndoPlugin } from "y-prosemirror"

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
      ...(awareness ? [yCursorPlugin(awareness)] : []),
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
