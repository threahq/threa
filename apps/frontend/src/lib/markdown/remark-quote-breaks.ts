/**
 * Render every line inside a blockquote as its own line.
 *
 * The serializer writes each quoted paragraph as a consecutive `> ` line, which
 * CommonMark folds into one paragraph joined by soft breaks. Outside a quote the
 * composer's lines are blank-line separated paragraphs, so turning the soft
 * breaks into hard ones is what makes a quote read the way it was typed.
 */
interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
}

export function remarkQuoteBreaks() {
  return (tree: MdastNode) => {
    breakLinesInChildren(tree, false)
  }
}

function breakLinesInChildren(node: MdastNode, inQuote: boolean): void {
  if (!node.children) return
  const next: MdastNode[] = []
  for (const child of node.children) {
    if (inQuote && child.type === "text" && child.value?.includes("\n")) {
      child.value.split("\n").forEach((line, index) => {
        if (index > 0) next.push({ type: "break" })
        if (line) next.push({ type: "text", value: line })
      })
      continue
    }
    breakLinesInChildren(child, inQuote || child.type === "blockquote")
    next.push(child)
  }
  node.children = next
}
