import { Extension } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import { linkFaviconUrl } from "@/api"
import { describeExternalLink } from "@/lib/external-links"
import { resolveInternalAppPath } from "@/lib/internal-url"

export interface ExternalLinkIconDecorationOptions {
  /** Null requests no favicons; bundled marks and the globe still draw. */
  workspaceId: string | null
}

interface IconState {
  decorations: DecorationSet
  /** Favicon urls drawn as the globe because their image has not loaded. */
  awaitedFavicons: ReadonlySet<string>
}

interface FaviconProbe {
  loaded: boolean
  requestedAt: number
  timedRetryUsed: boolean
}

const pluginKey = new PluginKey<IconState>("externalLinkIconDecoration")

// A host with no icon yet is asked again after this long: its icon arrives once the link is posted or a doc's
// favicon job has run, and the editor that showed the globe is usually still open.
const FAVICON_RETRY_MS = 30_000

function linkHref(node: ProseMirrorNode): string | null {
  const href = node.marks.find((mark) => mark.type.name === "link")?.attrs.href
  return typeof href === "string" ? href : null
}

/**
 * Draws the site icon a posted message shows before an external link (`ExternalLinkIcon`). The icon is the background
 * of a class the first node of each link run carries, so the caret, IME, copy and serialization never meet an extra
 * node.
 */
export const ExternalLinkIconDecoration = Extension.create<ExternalLinkIconDecorationOptions>({
  name: "externalLinkIconDecoration",

  addOptions() {
    return { workspaceId: null }
  },

  addProseMirrorPlugins() {
    const { workspaceId } = this.options
    // A favicon draws only once its image has loaded: CSS cannot fall back to the globe when a background 404s.
    const probes = new Map<string, FaviconProbe>()
    const retryTimers = new Set<ReturnType<typeof setTimeout>>()
    let redrawFrame: number | null = null

    const build = (doc: ProseMirrorNode): IconState => {
      const decorations: Decoration[] = []
      const awaitedFavicons = new Set<string>()

      const iconAttrs = (href: string): Record<string, string> | null => {
        const link = describeExternalLink(href)
        // Same-origin links are the app's own; posted messages draw them without a site icon too.
        if (!link || resolveInternalAppPath(href)) return null
        if (link.provider) return { class: `editor-link-icon external-link-icon-${link.provider}` }

        const src = workspaceId ? linkFaviconUrl(workspaceId, link.faviconHost) : null
        if (src && probes.get(src)?.loaded) {
          return { class: "editor-link-icon", style: `--external-link-glyph: url("${src}")` }
        }
        if (src) awaitedFavicons.add(src)
        return { class: "editor-link-icon external-link-icon-globe" }
      }

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
      return { decorations: DecorationSet.create(doc, decorations), awaitedFavicons }
    }

    // Icons that load in the same frame share one rebuild.
    const redrawSoon = (view: EditorView) => {
      redrawFrame ??= requestAnimationFrame(() => {
        redrawFrame = null
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(pluginKey, true))
      })
    }

    const requestFavicon = (view: EditorView, src: string) => {
      const probe = probes.get(src) ?? { loaded: false, requestedAt: 0, timedRetryUsed: false }
      probe.requestedAt = Date.now()
      probes.set(src, probe)

      const image = new Image()
      image.addEventListener("load", () => {
        probe.loaded = true
        redrawSoon(view)
      })
      image.addEventListener("error", () => {
        // One timed retry per host, so an idle editor still picks up the icon.
        if (probe.timedRetryUsed) return
        probe.timedRetryUsed = true
        const timer = setTimeout(() => {
          retryTimers.delete(timer)
          if (!view.isDestroyed && pluginKey.getState(view.state)?.awaitedFavicons.has(src)) requestFavicon(view, src)
        }, FAVICON_RETRY_MS)
        retryTimers.add(timer)
      })
      image.src = src
    }

    // A missed host is asked again only when its link comes back into the text, so typing in a document with many
    // unknown hosts never re-requests them all.
    const requestAwaitedFavicons = (view: EditorView, prevState?: EditorState) => {
      const awaited = pluginKey.getState(view.state)?.awaitedFavicons
      const previous = prevState && pluginKey.getState(prevState)?.awaitedFavicons
      if (!awaited || awaited === previous) return
      const now = Date.now()
      for (const src of awaited) {
        const probe = probes.get(src)
        const returned = !previous?.has(src) && probe && now - probe.requestedAt >= FAVICON_RETRY_MS
        if (!probe || returned) requestFavicon(view, src)
      }
    }

    return [
      new Plugin({
        key: pluginKey,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, icons) => (tr.docChanged || tr.getMeta(pluginKey) ? build(tr.doc) : icons),
        },
        props: {
          decorations: (state) => pluginKey.getState(state)?.decorations,
        },
        view: (view) => {
          requestAwaitedFavicons(view)
          return {
            update: requestAwaitedFavicons,
            destroy: () => {
              retryTimers.forEach(clearTimeout)
              if (redrawFrame !== null) cancelAnimationFrame(redrawFrame)
            },
          }
        },
      }),
    ]
  },
})
