import { findMathSpans } from "@threahq/prosemirror"

/**
 * Turn `$…$` / `$$…$$` runs inside text into the `math-inline` / `math-display`
 * elements `rehype-katex` renders.
 *
 * This runs over the parsed tree rather than the source, so code spans, fenced
 * code, and link destinations are already their own node types and a `$` inside
 * them is never mistaken for a delimiter. `findMathSpans` owns which runs count
 * as math — see `@threahq/prosemirror` for why `$5 and $10` does not.
 */
interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
  data?: Record<string, unknown>
}

export function remarkThreaMath() {
  return (tree: MdastNode) => {
    splitMathInChildren(tree)
  }
}

function splitMathInChildren(node: MdastNode): void {
  if (!node.children) return
  const next: MdastNode[] = []
  let replaced = false
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const parts = splitMath(child.value)
      if (parts) {
        next.push(...parts)
        replaced = true
        continue
      }
    }
    splitMathInChildren(child)
    next.push(child)
  }
  if (replaced) node.children = next
}

function splitMath(value: string): MdastNode[] | null {
  const spans = findMathSpans(value)
  if (spans.length === 0) return null
  const parts: MdastNode[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) parts.push({ type: "text", value: value.slice(cursor, span.start) })
    parts.push(mathNode(span.tex, span.display))
    cursor = span.end
  }
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) })
  return parts
}

/**
 * Display math renders as a `span` (KaTeX's own output is all spans) so it stays
 * valid inside the `<p>` the surrounding paragraph already opened.
 */
function mathNode(tex: string, display: boolean): MdastNode {
  return {
    // rehype-katex keys on the className alone; the mdast type only has to be
    // one remark-rehype does not recognize, so it takes the hName path.
    type: "math",
    value: tex,
    data: {
      hName: "span",
      hProperties: { className: display ? ["math", "math-display"] : ["math", "math-inline"] },
      hChildren: [{ type: "text", value: tex }],
    },
  }
}
