import type { Nodes, Root } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { gfm } from "micromark-extension-gfm"
import { buildSharedMessageHref } from "./pointer-urls"

const MESSAGE_ID_SOURCE = "msg_[0-9A-HJKMNP-TV-Z]{26}"
const BARE_MESSAGE_ID = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}_:/=?&])(${MESSAGE_ID_SOURCE})(?![\\p{L}\\p{N}\\p{M}_])`,
  "gu"
)
const MESSAGE_HREF = new RegExp(`^message:(?:(stream_[\\w-]+)[/:])?(${MESSAGE_ID_SOURCE})$`)

export interface ResolvedMessageReference {
  messageId: string
  streamId: string
}

export type MessageReferenceResolver = (
  workspaceId: string,
  messageIds: string[]
) => Promise<Map<string, ResolvedMessageReference>>

interface Replacement {
  start: number
  end: number
  messageId: string
  render: (reference: ResolvedMessageReference) => string
}

type PositionedNode = Nodes & {
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: Nodes[]
}

const PROTECTED_NODE_TYPES = new Set([
  "code",
  "inlineCode",
  "html",
  "image",
  "imageReference",
  "linkReference",
  "definition",
])

function nodeOffsets(node: PositionedNode): { start: number; end: number } | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start === undefined || end === undefined ? null : { start, end }
}

const CHARACTER_REFERENCE = /&#\d{1,7};|&#x[0-9a-fA-F]{1,6};|&[a-zA-Z][a-zA-Z0-9]{1,31};/

/** Raw source index for each decoded character of a text value; null when decoding does not align. */
function decodeOffsets(raw: string): number[] | null {
  const offsets: number[] = []
  let index = 0
  while (index < raw.length) {
    if (raw[index] === "\\" && index + 1 < raw.length) {
      offsets.push(index)
      index += 2
      continue
    }
    if (raw[index] === "&") {
      const reference = raw.slice(index).match(CHARACTER_REFERENCE)
      if (reference) {
        offsets.push(index)
        index += reference[0].length
        continue
      }
    }
    offsets.push(index)
    index += 1
  }
  return offsets
}

function collectTextReplacements(markdown: string, node: PositionedNode, replacements: Replacement[]): void {
  const span = nodeOffsets(node)
  if (!span || node.type !== "text") return

  const decodedOffsets = decodeOffsets(markdown.slice(span.start, span.end))
  if (!decodedOffsets || decodedOffsets.length !== node.value.length) return

  for (const match of node.value.matchAll(BARE_MESSAGE_ID)) {
    const start = span.start + decodedOffsets[match.index]
    const end = span.start + decodedOffsets[match.index + match[0].length - 1] + 1
    if (end - start !== match[0].length) continue
    replacements.push({
      start,
      end,
      messageId: match[0],
      render: (reference) => `[${match[0]}](${buildSharedMessageHref(reference)})`,
    })
  }
}

function collectMessageLinkReplacement(markdown: string, node: PositionedNode, replacements: Replacement[]): void {
  if (node.type !== "link") return
  const parsed = node.url.match(MESSAGE_HREF)
  const span = nodeOffsets(node)
  if (!parsed || !span) return

  const raw = markdown.slice(span.start, span.end)
  const destination = raw.match(new RegExp(`\\]\\(\\s*<?(${MESSAGE_HREF.source.slice(1, -1)})(?=>|\\s|\\))`))
  if (!destination || destination.index === undefined || destination[1] !== node.url) return

  const relativeStart = destination.index + destination[0].indexOf(destination[1])
  replacements.push({
    start: span.start + relativeStart,
    end: span.start + relativeStart + destination[1].length,
    messageId: parsed[2],
    render: (reference) => buildSharedMessageHref(reference),
  })
}

function collectReplacements(markdown: string, tree: Root): Replacement[] {
  const replacements: Replacement[] = []
  const visit = (node: PositionedNode, insideLink = false, insideHtml = false): void => {
    if (PROTECTED_NODE_TYPES.has(node.type)) return
    if (node.type === "link") {
      collectMessageLinkReplacement(markdown, node, replacements)
      return
    }
    const children = node.children ?? []
    const hasHtmlSibling = children.some((child: Nodes) => child.type === "html")
    if (!insideLink && !insideHtml && !hasHtmlSibling) {
      collectTextReplacements(markdown, node, replacements)
    }
    for (const child of children) visit(child as PositionedNode, insideLink, insideHtml || hasHtmlSibling)
  }
  visit(tree as PositionedNode)
  return replacements
}

/** Repair exact message IDs in model-authored markdown without reserializing it. */
export async function repairMessageReferences(
  markdown: string,
  workspaceId: string,
  resolve: MessageReferenceResolver
): Promise<string> {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const replacements = collectReplacements(markdown, tree)
  const candidates = [...new Set(replacements.map((replacement) => replacement.messageId))]
  if (candidates.length === 0) return markdown

  const resolved = await resolve(workspaceId, candidates)
  if (resolved.size === 0) return markdown

  let output = markdown
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    const reference = resolved.get(replacement.messageId)
    if (!reference) continue

    const parsed = markdown.slice(replacement.start, replacement.end).match(MESSAGE_HREF)
    const suppliedStreamId = parsed?.[1]
    if (suppliedStreamId && suppliedStreamId !== reference.streamId) continue
    output = output.slice(0, replacement.start) + replacement.render(reference) + output.slice(replacement.end)
  }
  return output
}
