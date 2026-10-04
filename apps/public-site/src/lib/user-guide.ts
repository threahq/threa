import { createMarkdownProcessor } from "@astrojs/markdown-remark"
import { groupGuideArticles, guideArticlesFromFiles, type GuideArticle } from "@threahq/user-guide"

import { apiBase } from "./config"
import { rehypeAppLinks } from "./rehype-app-links"

// The package's own loader reads from disk relative to its module, which no
// longer points at the content once Astro has bundled this code; the glob
// inlines the files instead and the package still owns their format.
const files = import.meta.glob<string>("../../../../packages/user-guide/content/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
})

export const guideArticles: GuideArticle[] = guideArticlesFromFiles(files)

export const guideSections = groupGuideArticles(guideArticles)

/** The overview page is "index"; DocsLayout matches `current` against these slugs. */
export const guideNav = [
  { group: "User guide", items: [{ slug: "index", label: "All articles", href: "/guide" }] },
  ...guideSections.map((section) => ({
    group: section.title,
    items: section.articles.map((a) => ({ slug: a.slug, label: a.title, href: `/guide/${a.slug}` })),
  })),
]

// Every docs page imports this module for the nav, so the processor is built
// only once an article actually renders.
let processor: ReturnType<typeof createMarkdownProcessor> | undefined

export async function renderGuideArticle(article: GuideArticle) {
  processor ??= createMarkdownProcessor({
    syntaxHighlight: false,
    rehypePlugins: [[rehypeAppLinks, { appUrl: apiBase }]],
  })
  const { code, metadata } = await (await processor).render(article.body)
  return {
    html: code,
    sections: metadata.headings.filter((h) => h.depth === 2).map((h) => ({ id: h.slug, label: h.text })),
  }
}
