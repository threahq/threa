import { AttachmentReferenceNode } from "@threahq/prosemirror/schema"
import { ReactNodeViewRenderer } from "@tiptap/react"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { isImageAttachment } from "@/lib/attachment-kind"
import { AttachmentReferenceView } from "./attachment-reference-view"

export type AttachmentStatus = "uploading" | "uploaded" | "error"

export type AttachmentDisplay = "pill" | "inline"

export const DISPLAY_TOGGLE_LABEL: Record<AttachmentDisplay, string> = {
  pill: "Show as image",
  inline: "Show as chip",
}

export interface AttachmentReferenceAttrs {
  /** Attachment ID (temp ID while uploading, real ID after) */
  id: string
  /** Original filename */
  filename: string
  /** MIME type for determining display (image vs file) */
  mimeType: string
  /** Size in bytes. Null when markdown was restored without attachment metadata. */
  sizeBytes: number | null
  /** Upload status */
  status: AttachmentStatus
  /** Image ordinal retained in content for backward compatibility; labels prefer the filename. */
  imageIndex: number | null
  /** Error message if status is "error" */
  error: string | null
  /** How the sent message draws it: a chip, or an image in the body. */
  display?: AttachmentDisplay
}

/** The current display of an image reference; null for any other node. */
export function imageReferenceDisplay(node: ProseMirrorNode): AttachmentDisplay | null {
  if (node.type.name !== "attachmentReference") return null
  const attrs = node.attrs as AttachmentReferenceAttrs
  if (!isImageAttachment(attrs)) return null
  return attrs.display === "inline" ? "inline" : "pill"
}

export function toggledDisplay(display: AttachmentDisplay): AttachmentDisplay {
  return display === "inline" ? "pill" : "inline"
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    attachmentReference: {
      /**
       * Insert an attachment reference at the current position
       */
      insertAttachmentReference: (attrs: AttachmentReferenceAttrs) => ReturnType
      /**
       * Insert attachment references together in one editor transaction.
       */
      insertAttachmentReferences: (attrs: AttachmentReferenceAttrs[]) => ReturnType
      /**
       * Update an attachment reference by its temp ID
       */
      updateAttachmentReference: (tempId: string, updates: Partial<AttachmentReferenceAttrs>) => ReturnType
      /**
       * Delete every reference to one attachment. The tray is the inventory, so
       * dropping a file from it drops the references drawn from it.
       */
      removeAttachmentReferences: (attachmentId: string) => ReturnType
    }
  }
}

export const AttachmentReferenceExtension = AttachmentReferenceNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentReferenceView)
  },

  addCommands() {
    return {
      insertAttachmentReference:
        (attrs) =>
        ({ commands }) =>
          commands.insertAttachmentReferences([attrs]),

      insertAttachmentReferences:
        (references) =>
        ({ chain, state }) => {
          if (references.length === 0) return false

          // Get marks at current position to preserve styling
          const { $from } = state.selection
          const { storedMarks } = state
          const currentMarks = storedMarks || $from.marks()
          const marks = currentMarks.map((mark: { type: { name: string }; attrs: Record<string, unknown> }) => ({
            type: mark.type.name,
            attrs: mark.attrs,
          }))
          const nodeBefore = $from.nodeBefore
          const isLineStart = $from.parentOffset === 0 || nodeBefore?.type.name === "hardBreak"
          let charBefore = ""
          if (nodeBefore?.isText) charBefore = nodeBefore.text?.slice(-1) ?? ""
          else if (nodeBefore) charBefore = "\uFFFC"
          const needsLeadingSpace = !isLineStart && charBefore !== "" && !/\s/u.test(charBefore)

          return chain()
            .insertContent([
              ...(needsLeadingSpace ? [{ type: "text", text: " ", marks }] : []),
              ...references.flatMap((attrs) => [
                { type: "attachmentReference", attrs, marks },
                { type: "text", text: " ", marks },
              ]),
            ])
            .run()
        },

      updateAttachmentReference:
        (tempId, updates) =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return false

          let found = false
          state.doc.descendants((node, pos) => {
            if (node.type.name === "attachmentReference" && node.attrs.id === tempId) {
              const newAttrs = { ...node.attrs, ...updates }
              tr.setNodeMarkup(pos, undefined, newAttrs)
              found = true
              return false // Stop traversal
            }
            return true
          })

          if (found) {
            dispatch(tr)
            return true
          }
          return false
        },

      removeAttachmentReferences:
        (attachmentId) =>
        ({ tr, state, dispatch }) => {
          const ranges: Array<{ from: number; to: number }> = []
          state.doc.descendants((node, pos) => {
            if (node.type.name === "attachmentReference" && node.attrs.id === attachmentId) {
              ranges.push({ from: pos, to: pos + node.nodeSize })
            }
            return true
          })
          if (ranges.length === 0) return false
          if (!dispatch) return true

          // Back to front: an earlier deletion would shift every later range.
          for (const range of ranges.reverse()) tr.delete(range.from, range.to)
          dispatch(tr)
          return true
        },
    }
  },
})
