import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { AttachmentReferenceView } from "./attachment-reference-view"

export type AttachmentStatus = "uploading" | "uploaded" | "error"

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
  /** Image index (1, 2, 3...) - only for images */
  imageIndex: number | null
  /** Error message if status is "error" */
  error: string | null
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    attachmentReference: {
      /**
       * Insert an attachment reference at the current position
       */
      insertAttachmentReference: (attrs: AttachmentReferenceAttrs) => ReturnType
      /**
       * Update an attachment reference by its temp ID
       */
      updateAttachmentReference: (tempId: string, updates: Partial<AttachmentReferenceAttrs>) => ReturnType
    }
  }
}

export const AttachmentReferenceExtension = Node.create({
  name: "attachmentReference",
  group: "inline",
  inline: true,
  selectable: true,
  atom: true,
  marks: "_", // Allow all marks (bold, italic, etc.)

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-id"),
        renderHTML: (attrs) => ({ "data-id": attrs.id }),
      },
      filename: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-filename"),
        renderHTML: (attrs) => ({ "data-filename": attrs.filename }),
      },
      mimeType: {
        default: "application/octet-stream",
        parseHTML: (element) => element.getAttribute("data-mime-type"),
        renderHTML: (attrs) => ({ "data-mime-type": attrs.mimeType }),
      },
      sizeBytes: {
        default: null,
        parseHTML: (element) => {
          const rawValue = element.getAttribute("data-size-bytes")
          if (rawValue === null || rawValue === "") return null
          if (!/^\d+$/.test(rawValue)) return null
          const parsed = Number(rawValue)
          return Number.isSafeInteger(parsed) ? parsed : null
        },
        renderHTML: (attrs) => (attrs.sizeBytes != null ? { "data-size-bytes": String(attrs.sizeBytes) } : {}),
      },
      status: {
        default: "uploading" as AttachmentStatus,
        parseHTML: (element) => element.getAttribute("data-status") as AttachmentStatus,
        renderHTML: (attrs) => ({ "data-status": attrs.status }),
      },
      imageIndex: {
        default: null,
        parseHTML: (element) => {
          const val = element.getAttribute("data-image-index")
          return val ? parseInt(val, 10) : null
        },
        renderHTML: (attrs) => (attrs.imageIndex ? { "data-image-index": String(attrs.imageIndex) } : {}),
      },
      error: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-error"),
        renderHTML: (attrs) => (attrs.error ? { "data-error": attrs.error } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="attachment-reference"]' }]
  },

  // No content hole: the node is an atom, and ProseMirror's DOMSerializer
  // throws on one ("Content hole not allowed in a leaf node spec"), taking
  // down every copy of a selection that holds a chip.
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "attachment-reference" })]
  },

  // Plain text rendering for copy/paste out of editor
  renderText({ node }) {
    const attrs = node.attrs as AttachmentReferenceAttrs
    if (attrs.status === "uploading") {
      return "[Uploading...]"
    }
    if (attrs.status === "error") {
      return "[Upload failed]"
    }
    const isImage = attrs.mimeType.startsWith("image/")
    if (isImage && attrs.imageIndex) {
      return `[Image #${attrs.imageIndex}]`
    }
    return `[${attrs.filename}]`
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentReferenceView)
  },

  addCommands() {
    return {
      insertAttachmentReference:
        (attrs) =>
        ({ chain, state }) => {
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
              { type: "attachmentReference", attrs, marks },
              { type: "text", text: " ", marks },
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
    }
  },
})
