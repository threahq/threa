import type { JSONContent } from "@threahq/types"
import { classifyDraftLink, type DraftLinkRef } from "@/lib/in-app-links"

/** The in-app stream/message ref of a node by its link mark's href (run membership). */
function inAppLinkRef(
  node: JSONContent,
  origin: string | null
): Extract<DraftLinkRef, { kind: "stream" | "message" }> | null {
  const href = node.marks?.find((m) => m.type === "link")?.attrs?.href
  if (typeof href !== "string") return null
  const ref = classifyDraftLink(href, origin)
  return ref && (ref.kind === "stream" || ref.kind === "message") ? ref : null
}

/** Any mark other than the link itself (bold/italic/code/…) — a styled segment. */
function hasNonLinkMarks(node: JSONContent): boolean {
  return (node.marks ?? []).some((m) => m.type !== "link")
}

/** Best-effort display text of an inline node, for the chip's pre-resolution label. */
function inlineText(node: JSONContent): string {
  if (typeof node.text === "string") return node.text
  if (node.type === "channelLink" && typeof node.attrs?.slug === "string") return `#${node.attrs.slug}`
  if (node.type === "mention" && typeof node.attrs?.slug === "string") return `@${node.attrs.slug}`
  return ""
}

/**
 * Collapse in-app stream/message link marks back into `inAppLink` atom nodes so
 * loading a draft or editing a posted message re-chips the links the composer
 * once chipped. `parseMarkdown` (shared, origin-blind) leaves an in-app
 * `[name](url)` as link-marked inline content — sometimes several nodes (a
 * `#slug`-shaped name parses to a channelLink), all carrying the same link
 * href — so consecutive nodes sharing one in-app href are merged into a single
 * chip. A run where any segment carries a non-link mark (a partly-bold link) is
 * left whole as styled link nodes: the chip is an atom and the serializer
 * ignores an atom's own marks, so chipping it would drop the formatting and
 * change the message on the next save. Idempotent: an existing `inAppLink` atom
 * carries no link mark and passes through untouched, and block nodes never carry
 * link marks so the same scan is safe at every depth.
 */
export function inAppLinkMarksToNodes(node: JSONContent, origin: string | null = currentOrigin()): JSONContent {
  if (!Array.isArray(node.content)) return node

  const children = node.content
  const out: JSONContent[] = []
  let i = 0
  while (i < children.length) {
    const ref = inAppLinkRef(children[i], origin)
    if (ref) {
      // Extend over the whole contiguous run sharing this in-app href, tracking
      // whether any segment is styled.
      let j = i + 1
      let styled = hasNonLinkMarks(children[i])
      let name = inlineText(children[i])
      while (j < children.length) {
        const next = inAppLinkRef(children[j], origin)
        if (!next || next.url !== ref.url) break
        styled ||= hasNonLinkMarks(children[j])
        name += inlineText(children[j])
        j++
      }
      if (styled) {
        for (; i < j; i++) out.push(inAppLinkMarksToNodes(children[i], origin))
        continue
      }
      out.push({
        type: "inAppLink",
        attrs: {
          url: ref.url,
          streamId: ref.streamId,
          messageId: ref.kind === "message" ? ref.messageId : null,
          name,
        },
      })
      i = j
    } else {
      out.push(inAppLinkMarksToNodes(children[i], origin))
      i++
    }
  }

  return { ...node, content: out }
}

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin
}
