import { Fragment, isValidElement, type ReactNode } from "react"

function flattenInline(children: ReactNode): string {
  if (children === null || children === undefined || typeof children === "boolean") return ""
  if (typeof children === "string") return children
  if (typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(flattenInline).join("")
  if (isValidElement(children)) {
    const props = children.props as Record<string, unknown>
    return flattenInline(props.children as ReactNode)
  }
  return ""
}

/**
 * Flatten block children to a stable plain-text string used as the content
 * key for per-message collapse persistence. Fragments are transparently
 * unwrapped so fragment-wrapped inputs and react-markdown arrays both work.
 */
export function extractBlockText(children: ReactNode): string {
  const parts: string[] = []
  const visit = (node: ReactNode) => {
    if (node === null || node === undefined || typeof node === "boolean") return
    if (typeof node === "string") {
      parts.push(node)
      return
    }
    if (typeof node === "number") {
      parts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (isValidElement(node)) {
      const props = node.props as Record<string, unknown>
      if (node.type === Fragment) {
        visit(props.children as ReactNode)
        return
      }
      parts.push(flattenInline(props.children as ReactNode))
    }
  }
  visit(children)
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n")
}
