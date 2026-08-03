import type { Editor } from "@tiptap/core"
import { isAllowedUri } from "@tiptap/extension-link"
import { find } from "linkifyjs"

const HOSTNAME_PROTOCOLS = new Set(["http:", "https:", "ftp:", "ftps:"])
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

function hasValidHostname(url: URL): boolean {
  if (!HOSTNAME_PROTOCOLS.has(url.protocol)) return true

  const hostname = url.hostname.replace(/\.$/u, "")
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true
  return !!hostname && hostname.split(".").every((label) => HOST_LABEL.test(label))
}

function pastedLinkHref(text: string): string | null {
  const value = text.trim()
  if (!value) return null

  const link = find(value, { defaultProtocol: "http" }).find((item) => item.isLink && item.value === value)
  if (!link || !isAllowedUri(link.href)) return null

  try {
    if (!hasValidHostname(new URL(link.href))) return null
  } catch {
    return null
  }

  return link.href
}

function selectionLinkConflicts(editor: Editor): Set<string> | null {
  const { from, to } = editor.state.selection
  const linkType = editor.state.schema.marks.link
  const conflictingMarks = new Set<string>()
  let hasText = false
  let unsupported = false

  editor.state.doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (node.isInline && !node.isText) {
      unsupported = true
      return false
    }
    if (!node.isText) return true

    hasText = true
    if (!parent?.type.allowsMarkType(linkType)) {
      unsupported = true
      return false
    }
    for (const mark of node.marks) {
      if (mark.type.excludes(linkType) || linkType.excludes(mark.type)) conflictingMarks.add(mark.type.name)
    }
    return true
  })

  return hasText && !unsupported ? conflictingMarks : null
}

export function pasteLinkOverSelection(editor: Editor, text: string): boolean {
  if (editor.state.selection.empty) return false

  const href = pastedLinkHref(text)
  const conflictingMarks = selectionLinkConflicts(editor)
  if (!href || !conflictingMarks) return false

  const chain = editor.chain()
  for (const mark of conflictingMarks) chain.unsetMark(mark)
  return chain.setLink({ href }).run()
}

export function handleBeforeInputLinkPaste(editor: Editor, event: InputEvent): boolean {
  const canBePaste =
    event.inputType === "insertText" ||
    event.inputType === "insertFromPaste" ||
    event.inputType === "insertReplacementText"
  if (!canBePaste || editor.view.composing) return false

  const text = event.data ?? event.dataTransfer?.getData("text/plain")
  if (!text || !pasteLinkOverSelection(editor, text)) return false

  event.preventDefault()
  return true
}
