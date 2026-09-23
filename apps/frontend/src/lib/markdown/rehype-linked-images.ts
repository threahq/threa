/**
 * Turn an image inside a link into the link's text.
 *
 * Images render as links to their source, so a linked image (`[![alt](src)](href)`,
 * or a README badge `<a href><img alt></a>`) would nest one anchor inside another.
 * The outer link is the one the author meant; the image contributes the text its
 * own renderer would show, the alt text or else its source.
 */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

export function rehypeLinkedImages() {
  return (tree: HastNode) => {
    rewrite(tree, false)
  }
}

function rewrite(node: HastNode, inLink: boolean): void {
  if (!node.children) return
  node.children = node.children.flatMap((child): HastNode[] => {
    if (inLink && child.tagName === "img") {
      const label = stringProperty(child, "alt") || stringProperty(child, "src")
      return label ? [{ type: "text", value: label }] : []
    }
    rewrite(child, inLink || child.tagName === "a")
    return [child]
  })
}

function stringProperty(node: HastNode, name: string): string {
  const value = node.properties?.[name]
  return typeof value === "string" ? value : ""
}
