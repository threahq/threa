import { Extension } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import { linkFaviconUrl } from "@/api"
import { describeExternalLink } from "@/lib/external-links"
import { resolveInternalAppPath } from "@/lib/internal-url"

export interface ExternalLinkIconDecorationOptions {
  /** Null requests no favicons; bundled marks and the globe still draw. */
  workspaceId: string | null
}

const pluginKey = new PluginKey<DecorationSet>("externalLinkIconDecoration")

// A host with no icon yet is asked again after this long: its icon arrives once the link is posted or a doc's
// favicon job has run, and the editor that showed the globe is usually still open.
const FAVICON_RETRY_MS = 30_000

function linkHref(node: ProseMirrorNode): string | null {
  const href = node.marks.find((mark) => mark.type.name === "link")?.attrs.href
  return typeof href === "string" ? href : null
}

/**
 * Draws the site icon a posted message shows before an external link (`ExternalLinkIcon`). The icon is generated
 * content on a class the first node of each link run carries, so the caret, IME, copy and serialization never meet
 * an extra node.
 */
export const ExternalLinkIconDecoration = Extension.create<ExternalLinkIconDecorationOptions>({
  name: "externalLinkIconDecoration",

  addOptions() {
    return { workspaceId: null }
  },

  addProseMirrorPlugins() {
    const { workspaceId } = this.options
    // A favicon draws only once its image has loaded: CSS cannot fall back to the globe when a background 404s.
    const loadedFavicons = new Set<string>()
    const faviconRequestedAt = new Map<string, number>()
    const wantedFavicons = new Set<string>()

    const iconAttrs = (href: string): Record<string, string> | null => {
      const link = describeExternalLink(href)
      // Same-origin links are the app's own; posted messages draw them without a site icon too.
      if (!link || resolveInternalAppPath(href)) return null
      if (link.provider) return { class: `editor-link-icon editor-link-icon-${link.provider}` }

      const src = workspaceId ? linkFaviconUrl(workspaceId, link.faviconHost) : null
      if (src && loadedFavicons.has(src)) {
        return { class: "editor-link-icon editor-link-icon-favicon", style: `--editor-link-favicon: url("${src}")` }
      }
      if (src) wantedFavicons.add(src)
      return { class: "editor-link-icon editor-link-icon-globe" }
    }

    const build = (doc: ProseMirrorNode): DecorationSet => {
      const decorations: Decoration[] = []
      doc.descendants((node, pos) => {
        if (!node.isTextblock) return true
        let previousHref: string | null = null
        node.forEach((child, offset) => {
          const href = linkHref(child)
          const attrs = href && href !== previousHref ? iconAttrs(href) : null
          const from = pos + 1 + offset
          if (attrs) decorations.push(Decoration.inline(from, from + child.nodeSize, attrs))
          previousHref = href
        })
        return false
      })
      return DecorationSet.create(doc, decorations)
    }

    const requestWantedFavicons = (view: EditorView) => {
      const now = Date.now()
      for (const src of wantedFavicons) {
        const requestedAt = faviconRequestedAt.get(src)
        if (requestedAt !== undefined && now - requestedAt < FAVICON_RETRY_MS) continue
        faviconRequestedAt.set(src, now)
        const image = new Image()
        image.addEventListener("load", () => {
          loadedFavicons.add(src)
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(pluginKey, true))
        })
        image.src = src
      }
      wantedFavicons.clear()
    }

    return [
      new Plugin({
        key: pluginKey,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, decorations) => (tr.docChanged || tr.getMeta(pluginKey) ? build(tr.doc) : decorations),
        },
        props: {
          decorations: (state) => pluginKey.getState(state),
        },
        view: (view) => {
          requestWantedFavicons(view)
          return { update: requestWantedFavicons }
        },
      }),
    ]
  },
})
