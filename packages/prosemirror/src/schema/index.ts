import { Extension, getSchema, type AnyExtension, type JSONContent } from "@tiptap/core"
import type { Schema } from "@tiptap/pm/model"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import HardBreak from "@tiptap/extension-hard-break"
import Heading from "@tiptap/extension-heading"
import BulletList from "@tiptap/extension-bullet-list"
import OrderedList from "@tiptap/extension-ordered-list"
import ListItem from "@tiptap/extension-list-item"
import { TaskList, TaskItem } from "@tiptap/extension-list"
import Blockquote from "@tiptap/extension-blockquote"
import HorizontalRule from "@tiptap/extension-horizontal-rule"
import CodeBlock from "@tiptap/extension-code-block"
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table"
import { Bold } from "@tiptap/extension-bold"
import { Italic } from "@tiptap/extension-italic"
import { Strike } from "@tiptap/extension-strike"
import { ThreaCode, ThreaLink } from "./marks"
import {
  AttachmentReferenceNode,
  QuoteReplyNode,
  AgentBlockNode,
  SharedMessageNode,
  MemoEmbedNode,
  InAppLinkNode,
  GiphyEmbedNode,
  MathNode,
  EmojiNode,
} from "./nodes"
import { MentionNode, ChannelLinkNode, SlashCommandNode } from "./triggers"
import { BLOCK_ID_NODE_TYPES } from "./attributes"
export { BLOCK_ID_NODE_TYPES } from "./attributes"

export { ThreaCode, ThreaLink } from "./marks"
export { ThreaHeading, ThreaTable, TaskList, ThreaTaskItem, BlockIdAttribute, codeBlockOptions }
export {
  AttachmentReferenceNode,
  QuoteReplyNode,
  AgentBlockNode,
  SharedMessageNode,
  MemoEmbedNode,
  InAppLinkNode,
  GiphyEmbedNode,
  MathNode,
  EmojiNode,
} from "./nodes"
export { MentionNode, ChannelLinkNode, SlashCommandNode } from "./triggers"

const ThreaHeading = Heading.configure({ levels: [1, 2, 3] })
const ThreaTable = Table.configure({ resizable: false })
const ThreaTaskItem = TaskItem.configure({ nested: true })
const codeBlockOptions = { defaultLanguage: "plaintext" }

const BlockIdAttribute = Extension.create({
  name: "blockId",
  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_ID_NODE_TYPES],
        attributes: {
          // JSON-only: `rendered: false` keeps ids out of HTML, so a paste never
          // carries one; `keepOnSplit: false` only covers an end-of-block Enter,
          // a mid-block split still copies the id. The write sink is what keeps
          // ids unique per document.
          blockId: { default: null, rendered: false, keepOnSplit: false },
        },
      },
    ]
  },
})

function createSchemaExtensions(): AnyExtension[] {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    Bold,
    Italic,
    Strike,
    ThreaCode,
    ThreaLink,
    ThreaHeading,
    BulletList,
    OrderedList,
    ListItem,
    TaskList,
    ThreaTaskItem,
    Blockquote,
    HorizontalRule,
    CodeBlock.configure(codeBlockOptions),
    ThreaTable,
    TableRow,
    TableHeader,
    TableCell,
    AttachmentReferenceNode,
    QuoteReplyNode,
    AgentBlockNode,
    SharedMessageNode,
    MemoEmbedNode,
    InAppLinkNode,
    GiphyEmbedNode,
    MathNode,
    MentionNode,
    ChannelLinkNode,
    SlashCommandNode,
    EmojiNode,
    BlockIdAttribute,
  ]
}

let threaSchema: Schema | null = null

export function getThreaSchema(): Schema {
  threaSchema ??= getSchema(createSchemaExtensions())
  return threaSchema
}

export class InvalidContentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "InvalidContentError"
  }
}

/**
 * The doc as ProseMirror loads it: checked against the schema, attribute
 * defaults filled in. Store this, not the input, so what the serializer and
 * the editor read is what was validated.
 */
export function normalizeContentJson(json: JSONContent): JSONContent {
  const schema = getThreaSchema()
  try {
    const node = schema.nodeFromJSON(json)
    node.check()
    return node.toJSON()
  } catch (error) {
    throw new InvalidContentError(error instanceof Error ? error.message : String(error), { cause: error })
  }
}
