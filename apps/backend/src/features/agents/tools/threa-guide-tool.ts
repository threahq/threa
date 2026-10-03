import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threahq/types"
import { GUIDE_URL, groupGuideArticles, type GuideArticle } from "@threahq/user-guide"
import { defineAgentTool, type AgentToolResult } from "../runtime"

const ThreaGuideSchema = z.object({
  article: z.string().describe("Slug from the guide index, e.g. meet-ariadne"),
})

export type ThreaGuideInput = z.infer<typeof ThreaGuideSchema>

function buildPromptBlock(articles: readonly GuideArticle[]): string {
  const sections = groupGuideArticles(articles).flatMap((section) => [
    `**${section.title}**`,
    ...section.articles.map((article) => `- ${article.slug}: ${article.title} — ${article.summary}`),
  ])

  return `## Threa user guide

You have a \`${AgentToolNames.THREA_GUIDE}\` tool that reads Threa's public user guide. Use it when someone asks how Threa works, where a setting or feature is, or what something in the app does.
Read the article before answering instead of guessing from memory.
Point people at places in the app with \`app:\` links as the article does, and cite ${GUIDE_URL}/<slug> when they want to read more.
The guide is a rough draft: if no article covers the question, say so rather than filling the gap.

${sections.join("\n")}`
}

/** The article index goes in the promptBlock (stable text) so it stays in the cached system prompt. */
export function createThreaGuideTool({ articles }: { articles: readonly GuideArticle[] }) {
  return defineAgentTool({
    name: AgentToolNames.THREA_GUIDE,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.THREA_GUIDE],
    promptBlock: buildPromptBlock(articles),
    description: `Read an article of Threa's public user guide by slug (from the guide index in your instructions). Returns the article as markdown with its public URL. Use it to answer how-to questions about the app.`,
    inputSchema: ThreaGuideSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const article = articles.find((a) => a.slug === input.article)
      if (!article) {
        return { output: JSON.stringify({ error: "No guide article with that slug", article: input.article }) }
      }
      return {
        output: JSON.stringify({
          title: article.title,
          url: `${GUIDE_URL}/${article.slug}`,
          // Article links are site-relative; the reader is not on the site.
          markdown: article.body.replaceAll("](/guide/", `](${GUIDE_URL}/`),
        }),
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) => JSON.stringify({ tool: AgentToolNames.THREA_GUIDE, article: input.article }),
    },
  })
}
