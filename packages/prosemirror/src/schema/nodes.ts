import { Node, mergeAttributes } from "@tiptap/core"
import { attachmentReferenceLabel } from "../markdown"
import { type Attrs, dataAttr, optionalDataAttr, referencePinAttributes } from "./attributes"

function parsePositiveInteger(raw: string | null): number | null {
  if (raw === null) return null
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

export const AttachmentReferenceNode = Node.create({
  name: "attachmentReference",
  group: "inline",
  inline: true,
  selectable: true,
  atom: true,
  marks: "_",

  addAttributes() {
    return {
      id: dataAttr("id", "data-id", null),
      filename: dataAttr("filename", "data-filename", ""),
      mimeType: dataAttr("mimeType", "data-mime-type", "application/octet-stream"),
      sizeBytes: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const rawValue = element.getAttribute("data-size-bytes")
          if (rawValue === null || rawValue === "") return null
          if (!/^\d+$/.test(rawValue)) return null
          const parsed = Number(rawValue)
          return Number.isSafeInteger(parsed) ? parsed : null
        },
        renderHTML: (attrs: Attrs) => (attrs.sizeBytes != null ? { "data-size-bytes": String(attrs.sizeBytes) } : {}),
      },
      status: dataAttr("status", "data-status", "uploading"),
      imageIndex: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const val = element.getAttribute("data-image-index")
          return val ? parseInt(val, 10) : null
        },
        renderHTML: (attrs: Attrs) => (attrs.imageIndex ? { "data-image-index": String(attrs.imageIndex) } : {}),
      },
      error: optionalDataAttr("error", "data-error"),
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

  renderText({ node }) {
    if (node.attrs.status === "uploading") return "[Uploading...]"
    if (node.attrs.status === "error") return "[Upload failed]"
    return `[${attachmentReferenceLabel(node.attrs)}]`
  },
})

export const QuoteReplyNode = Node.create({
  name: "quoteReply",
  group: "block",
  selectable: true,
  draggable: false,
  atom: true,

  addAttributes() {
    return {
      messageId: dataAttr("messageId", "data-message-id", null),
      streamId: dataAttr("streamId", "data-stream-id", null),
      authorName: dataAttr("authorName", "data-author-name", ""),
      authorId: dataAttr("authorId", "data-author-id", ""),
      actorType: dataAttr("actorType", "data-actor-type", "user"),
      snippet: dataAttr("snippet", "data-snippet", ""),
      // Server-set: the author couldn't read the source, so only the ids remain.
      private: {
        default: false,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-private") === "true",
        renderHTML: (attrs: Attrs) => (attrs.private ? { "data-private": "true" } : {}),
      },
      ...referencePinAttributes,
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="quote-reply"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "quote-reply" })]
  },

  renderText({ node }) {
    return `> ${node.attrs.snippet}\n> — ${node.attrs.authorName}\n`
  },
})

export const AgentBlockNode = Node.create({
  name: "agentBlock",
  group: "block",
  content: "block+",
  // Keeps the node and its attrs around edits that replace its content, so a
  // rewrite inside the frame can't launder agent text into unattributed text.
  defining: true,
  draggable: false,

  addAttributes() {
    return {
      authorId: dataAttr("authorId", "data-author-id", ""),
      authorName: dataAttr("authorName", "data-author-name", ""),
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="agent-block"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "agent-block" }), 0]
  },
})

export const SharedMessageNode = Node.create({
  name: "sharedMessage",
  group: "block",
  selectable: true,
  draggable: false,
  atom: true,

  addAttributes() {
    return {
      messageId: dataAttr("messageId", "data-message-id", null),
      streamId: dataAttr("streamId", "data-stream-id", null),
      authorName: dataAttr("authorName", "data-author-name", ""),
      authorId: dataAttr("authorId", "data-author-id", ""),
      actorType: dataAttr("actorType", "data-actor-type", "user"),
      // Omitted when the message has no conversation origin, keeping the legacy
      // two-segment pointer shape.
      conversationId: optionalDataAttr("conversationId", "data-conversation-id"),
      ...referencePinAttributes,
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="shared-message"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "shared-message" })]
  },

  renderText({ node }) {
    return `[shared message ${node.attrs.messageId}]\n`
  },
})

export const MemoEmbedNode = Node.create({
  name: "memoEmbed",
  group: "inline",
  inline: true,
  selectable: true,
  atom: true,
  marks: "_",

  addAttributes() {
    return {
      memoId: dataAttr("memoId", "data-memo-id", null),
      title: dataAttr("title", "data-title", ""),
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="memo-embed"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "memo-embed" })]
  },

  renderText({ node }) {
    return node.attrs.title || "Memo"
  },
})

export const InAppLinkNode = Node.create({
  name: "inAppLink",
  group: "inline",
  inline: true,
  selectable: true,
  atom: true,
  marks: "_",

  addAttributes() {
    return {
      url: dataAttr("url", "data-url", null),
      streamId: dataAttr("streamId", "data-stream-id", null),
      messageId: optionalDataAttr("messageId", "data-message-id"),
      name: dataAttr("name", "data-name", ""),
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="in-app-link"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "in-app-link" })]
  },

  renderText({ node }) {
    return node.attrs.name || "Link"
  },
})

export const GiphyEmbedNode = Node.create({
  name: "giphyEmbed",
  group: "inline",
  inline: true,
  selectable: true,
  atom: true,
  marks: "_",

  addAttributes() {
    return {
      giphyUrl: dataAttr("giphyUrl", "data-giphy-url", null),
      title: dataAttr("title", "data-title", ""),
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => parsePositiveInteger(element.getAttribute("data-width")),
        renderHTML: (attrs: Attrs) => (attrs.width ? { "data-width": String(attrs.width) } : {}),
      },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => parsePositiveInteger(element.getAttribute("data-height")),
        renderHTML: (attrs: Attrs) => (attrs.height ? { "data-height": String(attrs.height) } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="giphy-embed"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "giphy-embed" })]
  },

  renderText({ node }) {
    return node.attrs.title || "GIF"
  },
})

// Inline atom rather than a block: `$$…$$` sits inside a paragraph in markdown,
// and the message renderer puts its display equation there too, so the node
// that round-trips to it belongs in the same place. `display` decides how it
// draws, not where it lives.
export const MathNode = Node.create({
  name: "math",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  // The equation's appearance comes from its TeX, so bold or a link on it
  // would be a promise the sent message cannot keep.
  marks: "",

  addAttributes() {
    return {
      tex: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-tex") ?? "",
        renderHTML: (attrs: Attrs) => ({ "data-tex": attrs.tex }),
      },
      display: {
        default: false,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-display") === "true",
        renderHTML: (attrs: Attrs) => ({ "data-display": attrs.display ? "true" : "false" }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="math"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "math" })]
  },

  renderText({ node }) {
    return node.attrs.display ? `$$${node.attrs.tex}$$` : `$${node.attrs.tex}$`
  },
})

export const EmojiNode = Node.create({
  name: "emoji",
  group: "inline",
  inline: true,
  selectable: false,
  atom: true,
  marks: "_",

  addAttributes() {
    return {
      shortcode: dataAttr("shortcode", "data-shortcode", null),
      emoji: dataAttr("emoji", "data-emoji", null),
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="emoji"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "emoji" }), node.attrs.emoji]
  },

  renderText({ node }) {
    return `:${node.attrs.shortcode}:`
  },
})
