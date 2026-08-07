import { serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import { stripMarkdownToInline } from "@/lib/markdown"

function stringAttr(node: JSONContent, name: string): string {
  const value = node.attrs?.[name]
  return typeof value === "string" ? value : ""
}

function humanizeNodeType(type: string | undefined): string {
  if (!type) return "Content"
  const words = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

function serializedPreview(node: JSONContent): string {
  return stripMarkdownToInline(serializeToMarkdown({ type: "doc", content: [node] })).trim()
}

function attachmentPreview(node: JSONContent): string {
  const filename = stringAttr(node, "filename")
  const status = stringAttr(node, "status")
  if (status === "uploading") return filename ? `Uploading ${filename}…` : "Uploading attachment…"
  if (status === "error") return filename ? `${filename} upload failed` : "Attachment upload failed"
  if (filename) return filename

  const imageIndex = node.attrs?.imageIndex
  return typeof imageIndex === "number" ? `Image #${imageIndex}` : "Attachment"
}

function previewTable(node: JSONContent): string {
  const firstCell = node.content?.flatMap((row) => row.content ?? []).find((cell) => previewNode(cell).trim() !== "")
  const cellPreview = firstCell ? previewNode(firstCell) : ""
  return cellPreview ? `Table: ${cellPreview}` : "Table"
}

function previewChildren(node: JSONContent): string {
  const parts: string[] = []
  for (const child of node.content ?? []) {
    if (child.type === "hardBreak") {
      if (parts.join("").trim() !== "") break
      parts.length = 0
      continue
    }
    const preview = previewNode(child)
    if (preview) parts.push(preview)
  }
  return parts.join("")
}

function previewFirstChild(node: JSONContent): string {
  for (const child of node.content ?? []) {
    const preview = previewNode(child)
    if (preview.trim() !== "") return preview
  }
  return ""
}

function previewNode(node: JSONContent): string {
  if (node.type === "text") return node.text ?? ""
  if (node.type === "hardBreak") return ""

  if (node.type === "mention") {
    const label = stringAttr(node, "slug") || stringAttr(node, "label")
    return label ? `@${label}` : "Mention"
  }
  if (node.type === "channelLink") {
    const slug = stringAttr(node, "slug")
    return slug ? `#${slug}` : "Channel"
  }
  if (node.type === "slashCommand") {
    const name = stringAttr(node, "name")
    return name ? `/${name}` : "Command"
  }
  if (node.type === "emoji") {
    const emoji = stringAttr(node, "emoji")
    if (emoji) return emoji
    const shortcode = stringAttr(node, "shortcode")
    return shortcode ? `:${shortcode}:` : "Emoji"
  }
  if (node.type === "attachmentReference") return attachmentPreview(node)
  if (node.type === "inAppLink") return stringAttr(node, "name") || "Link"

  if (node.type === "quoteReply") {
    const author = stringAttr(node, "authorName")
    return author ? `Replying to ${author}` : "Quoted reply"
  }
  if (node.type === "sharedMessage") {
    const author = stringAttr(node, "authorName")
    return author ? `Sharing message from ${author}` : "Sharing a message"
  }
  if (node.type === "memoEmbed") {
    const title = stringAttr(node, "title")
    return title ? `Memo: ${title}` : "Memo"
  }
  if (node.type === "giphyEmbed") {
    const title = stringAttr(node, "title")
    return title ? `GIF: ${title}` : "GIF"
  }
  if (node.type === "horizontalRule") return "Divider"
  if (node.type === "table") return previewTable(node)
  if (node.type === "codeBlock") {
    const lines = (node.content ?? [])
      .map((child) => child.text ?? "")
      .join("")
      .split("\n")
    return lines.find((line) => line.trim() !== "") ?? ""
  }

  if (node.type === "paragraph" || node.type === "heading") {
    return previewChildren(node)
  }
  if (
    node.type === "doc" ||
    node.type === "bulletList" ||
    node.type === "orderedList" ||
    node.type === "listItem" ||
    node.type === "blockquote" ||
    node.type === "tableRow" ||
    node.type === "tableHeader" ||
    node.type === "tableCell"
  ) {
    return previewFirstChild(node)
  }

  const childPreview = previewFirstChild(node)
  if (childPreview) return childPreview

  const canonicalPreview = serializedPreview(node)
  return canonicalPreview || humanizeNodeType(node.type)
}

function hasMultipleMeaningfulChildren(node: JSONContent): boolean {
  let meaningful = 0
  for (const child of node.content ?? []) {
    if (previewNode(child).trim() === "") continue
    meaningful += 1
    if (meaningful > 1) return true
  }
  return false
}

function isMultiline(node: JSONContent): boolean {
  if (node.type === "codeBlock") {
    return (node.content ?? []).some((child) => (child.text ?? "").includes("\n"))
  }
  if (node.type === "table") return true
  if (node.type === "paragraph" || node.type === "heading") {
    return (node.content ?? []).some((child) => child.type === "hardBreak")
  }
  if (
    node.type === "doc" ||
    node.type === "bulletList" ||
    node.type === "orderedList" ||
    node.type === "listItem" ||
    node.type === "blockquote" ||
    node.type === "tableRow" ||
    node.type === "tableHeader" ||
    node.type === "tableCell"
  ) {
    if (hasMultipleMeaningfulChildren(node)) return true
    const first = (node.content ?? []).find((child) => previewNode(child).trim() !== "")
    return first ? isMultiline(first) : false
  }
  return false
}

/**
 * One-line semantic projection of a composer document for collapsed mobile
 * chrome. Known atoms keep concise labels; canonical markdown serialization is
 * the fallback for new sendable nodes, and an unknown leaf still names itself
 * instead of making a non-empty draft look empty.
 */
export function collapsedComposerPreview(content: JSONContent): string {
  const preview = previewNode(content).trim()
  if (!preview) return ""
  return isMultiline(content) ? `${preview}…` : preview
}
