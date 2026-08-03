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

export function pasteLinkOverSelection(editor: Editor, text: string): boolean {
  const { from, to, empty } = editor.state.selection
  if (empty || !editor.state.doc.textBetween(from, to)) return false

  const href = pastedLinkHref(text)
  if (!href) return false

  return editor.commands.setLink({ href })
}

export function handleBeforeInputLinkPaste(editor: Editor, event: InputEvent): boolean {
  const isReplacement = event.inputType === "insertReplacementText"
  const targetRanges = typeof event.getTargetRanges === "function" ? event.getTargetRanges() : []
  const replacesTargetRange = isReplacement && targetRanges.some((range) => !range.collapsed)
  const canBePaste = event.inputType === "insertText" || event.inputType === "insertFromPaste" || isReplacement
  if (!canBePaste || replacesTargetRange || editor.view.composing) return false

  const text = event.data ?? event.dataTransfer?.getData("text/plain")
  if (!text || !pasteLinkOverSelection(editor, text)) return false

  event.preventDefault()
  return true
}
