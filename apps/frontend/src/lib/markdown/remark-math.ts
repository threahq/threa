import { splitMathTokens, unescapeTableCellTex } from "@threahq/prosemirror"

/**
 * Turn the math tokens `extractMath` left in the source into the
 * `math-inline` / `math-display` elements `rehype-katex` renders.
 *
 * The tokens were substituted before parsing, so each one is a single
 * uninterruptible text run here and the TeX inside it never met CommonMark's
 * escaping or emphasis rules.
 */
interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
  data?: Record<string, unknown>
}

export function remarkThreaMath() {
  return (tree: MdastNode) => {
    splitMathInChildren(tree, false)
  }
}

function splitMathInChildren(node: MdastNode, inTableCell: boolean): void {
  if (!node.children) return
  const next: MdastNode[] = []
  let replaced = false
  for (const child of node.children) {
    // Raw HTML is parsed after this pass, so a token left in it would reach the
    // page as private-use garbage. Its math goes back to the TeX source instead.
    if (child.type === "html" && typeof child.value === "string") {
      child.value = restoreMathSource(child.value)
    }
    if (child.type === "text" && typeof child.value === "string") {
      const parts = splitMathTokens(child.value)
      if (parts) {
        next.push(
          ...parts.map((part) => {
            if (!("tex" in part)) return textNode(part.text)
            return mathNode(inTableCell ? unescapeTableCellTex(part.tex) : part.tex, part.display)
          })
        )
        replaced = true
        continue
      }
    }
    splitMathInChildren(child, inTableCell || child.type === "tableCell")
    next.push(child)
  }
  if (replaced) node.children = next
}

function restoreMathSource(html: string): string {
  const parts = splitMathTokens(html)
  if (!parts) return html
  return parts
    .map((part) => {
      if (!("tex" in part)) return part.text
      const delimiter = part.display ? "$$" : "$"
      return delimiter + part.tex + delimiter
    })
    .join("")
}

function textNode(value: string): MdastNode {
  return { type: "text", value }
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
