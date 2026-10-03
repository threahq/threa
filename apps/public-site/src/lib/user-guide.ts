import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { GUIDE_SECTIONS, parseGuideArticle, sortGuideArticles, type GuideArticle } from "@threahq/user-guide"

import { apiBase } from "./config"
import { rehypeAppLinks } from "./rehype-app-links"

// The package's own loader reads from disk relative to its module, which no
// longer points at the content once Astro has bundled this code; the glob
// inlines the files instead and the shared parser still owns their format.
const files = import.meta.glob<string>("../../../../packages/user-guide/content/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
})

export const guideArticles: GuideArticle[] = sortGuideArticles(
  Object.entries(files).map(([path, raw]) =>
    parseGuideArticle(path.slice(path.lastIndexOf("/") + 1, -".md".length), raw)
  )
)

/** The overview page is "index"; DocsLayout matches `current` against these slugs. */
export const guideNav = [
  { group: "User guide", items: [{ slug: "index", label: "All articles", href: "/guide" }] },
  ...GUIDE_SECTIONS.map((section) => ({
    group: section.title,
    items: guideArticles
      .filter((a) => a.section === section.id)
      .map((a) => ({ slug: a.slug, label: a.title, href: `/guide/${a.slug}` })),
  })).filter((g) => g.items.length > 0),
]

export const guideSections = GUIDE_SECTIONS.map((section) => ({
  ...section,
  articles: guideArticles.filter((a) => a.section === section.id),
})).filter((s) => s.articles.length > 0)

const processor = createMarkdownProcessor({ rehypePlugins: [[rehypeAppLinks, { appUrl: apiBase }]] })

export async function renderGuideArticle(article: GuideArticle) {
  const { code, metadata } = await (await processor).render(article.body)
  return {
    html: code,
    sections: metadata.headings.filter((h) => h.depth === 2).map((h) => ({ id: h.slug, label: h.text })),
  }
}
