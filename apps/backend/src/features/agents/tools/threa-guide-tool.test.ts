import { describe, expect, test } from "bun:test"
import { parseGuideArticle } from "@threahq/user-guide"
import { createThreaGuideTool } from "./threa-guide-tool"

const toolOpts = { toolCallId: "test" }

function article(slug: string, title: string, summary: string, section: string, order = 1, body = `Body of ${slug}.`) {
  return parseGuideArticle(
    slug,
    `---\ntitle: ${title}\nsummary: ${summary}\nsection: ${section}\norder: ${order}\n---\n\n# ${title}\n\n${body}`
  )
}

const articles = [
  article(
    "meet-ariadne",
    "Meet Ariadne",
    "What she is and what she can do",
    "agents",
    1,
    "Start with [Quick start](/guide/quick-start) and open [Memory](app:memory)."
  ),
  article("quick-start", "Quick start", "Your first five minutes", "getting-started"),
  article("ask-ariadne", "Ask Ariadne", "Start a conversation", "agents", 2),
]

describe("threa_guide tool", () => {
  test("should list every article under its section in the prompt block when built", () => {
    const tool = createThreaGuideTool({ articles })
    const block = tool.config.promptBlock!

    expect(block.slice(block.indexOf("**Getting started**"))).toBe(
      [
        "**Getting started**",
        "- quick-start: Quick start — Your first five minutes",
        "**Agents and Ariadne**",
        "- meet-ariadne: Meet Ariadne — What she is and what she can do",
        "- ask-ariadne: Ask Ariadne — Start a conversation",
      ].join("\n")
    )
  })

  test("should return the article markdown with absolute guide links when the slug exists", async () => {
    const tool = createThreaGuideTool({ articles })

    const { output } = await tool.config.execute({ article: "meet-ariadne" }, toolOpts)

    expect(JSON.parse(output)).toEqual({
      title: "Meet Ariadne",
      url: "https://threa.io/guide/meet-ariadne",
      markdown:
        "# Meet Ariadne\n\nStart with [Quick start](https://threa.io/guide/quick-start) and open [Memory](app:memory).",
    })
  })

  test("should return an error when the slug is unknown", async () => {
    const tool = createThreaGuideTool({ articles })

    const { output } = await tool.config.execute({ article: "nope" }, toolOpts)

    expect(JSON.parse(output)).toEqual({ error: "No guide article with that slug", article: "nope" })
  })
})
