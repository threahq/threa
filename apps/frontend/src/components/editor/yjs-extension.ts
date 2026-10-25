import { Extension } from "@tiptap/core"
import * as Y from "yjs"
// The server applies and reads this fragment with the same pinned y-prosemirror
// (`apps/backend/src/features/docs/yjs.ts`); keep both on one exact version so
// the client writes the structure the server parses.
import { redo, undo, ySyncPlugin, yUndoPlugin } from "y-prosemirror"

interface YjsCollaborationOptions {
  ydoc: Y.Doc
  fragment: string
}

export const YjsCollaboration = Extension.create<YjsCollaborationOptions>({
  name: "yjsCollaboration",

  addOptions() {
    return { ydoc: new Y.Doc(), fragment: "default" }
  },

  addProseMirrorPlugins() {
    return [ySyncPlugin(this.options.ydoc.getXmlFragment(this.options.fragment)), yUndoPlugin()]
  },

  addKeyboardShortcuts() {
    return {
      "Mod-z": ({ editor }) => undo(editor.state),
      "Mod-y": ({ editor }) => redo(editor.state),
      "Shift-Mod-z": ({ editor }) => redo(editor.state),
    }
  },
})
