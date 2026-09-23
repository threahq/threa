/**
 * Turn an image inside a link into the link's text.
 *
 * Images render as links to their source, so a linked image (`[![alt](src)](href)`,
 * or a README badge `<a href><img alt></a>`) would nest one anchor inside another.
 * The outer link is the one the author meant; the image contributes its alt text,
 * and a link that held only alt-less images is dropped.
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

/** Returns whether an image was taken out of `node`'s subtree. */
function rewrite(node: HastNode, inLink: boolean): boolean {
  if (!node.children) return false
  let removedImage = false
  const next: HastNode[] = []
  for (const child of node.children) {
    if (inLink && child.tagName === "img") {
      removedImage = true
      const alt = typeof child.properties?.alt === "string" ? child.properties.alt : ""
      if (alt) next.push({ type: "text", value: alt })
      continue
    }
    const isLink = child.tagName === "a"
    const childRemovedImage = rewrite(child, inLink || isLink)
    removedImage ||= childRemovedImage
    if (isLink && childRemovedImage && !hasText(child)) continue
    next.push(child)
  }
  node.children = next
  return removedImage
}

function hasText(node: HastNode): boolean {
  if (node.type === "text") return Boolean(node.value?.trim())
  return node.children?.some(hasText) ?? false
}
