import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threahq/types"
import { GUIDE_SECTIONS, type GuideArticle } from "@threahq/user-guide"
import { defineAgentTool, type AgentToolResult } from "../runtime"

const ThreaGuideSchema = z.object({
  article: z.string().describe("Slug from the guide index, e.g. meet-ariadne"),
})

export type ThreaGuideInput = z.infer<typeof ThreaGuideSchema>

const GUIDE_URL = "https://threa.io/guide"

function buildPromptBlock(articles: readonly GuideArticle[]): string {
  const sections = GUIDE_SECTIONS.flatMap((section) => {
    const inSection = articles.filter((article) => article.section === section.id)
    if (inSection.length === 0) return []
    return [
      `**${section.title}**`,
      ...inSection.map((article) => `- ${article.slug}: ${article.title} — ${article.summary}`),
    ]
  })

  return `## Threa user guide

You have a \`threa_guide\` tool that reads Threa's public user guide. Use it when someone asks how Threa works, where a setting or feature is, or what something in the app does.
Read the article before answering instead of guessing from memory.
Point people at places in the app with \`app:\` links as the article does, and cite ${GUIDE_URL}/<slug> when they want to read more.
The guide is a rough draft: if no article covers the question, say so rather than filling the gap.

${sections.join("\n")}`
}

/**
 * Reads one article of the bundled public user guide by slug. The article
 * index lives in the prompt block (stable text, so it stays in the cached
 * system prompt); the guide is bundled with the backend, so no I/O happens
 * at call time.
 */
export function createThreaGuideTool({ articles }: { articles: readonly GuideArticle[] }) {
  const bySlug = new Map(articles.map((article) => [article.slug, article]))

  return defineAgentTool({
    name: "threa_guide",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.THREA_GUIDE],
    promptBlock: buildPromptBlock(articles),
    description: `Read an article of Threa's public user guide by slug (from the guide index in your instructions). Returns the article as markdown with its public URL. Use it to answer how-to questions about the app.`,
    inputSchema: ThreaGuideSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const article = bySlug.get(input.article)
      if (!article) {
        return { output: JSON.stringify({ error: "No guide article with that slug", article: input.article }) }
      }
      return {
        output: JSON.stringify({
          slug: article.slug,
          title: article.title,
          section: article.section,
          url: `${GUIDE_URL}/${article.slug}`,
          markdown: article.body,
        }),
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) => JSON.stringify({ tool: "threa_guide", article: input.article }),
    },
  })
}
