import { describe, it, expect, vi } from "vitest"
import { render as rtlRender, screen, fireEvent } from "@testing-library/react"
import type { ReactElement } from "react"
import { MemoryRouter } from "react-router-dom"
import { StreamTypes } from "@threahq/types"
import { MentionProvider, type MentionType } from "@/lib/markdown/mention-context"
import { ChannelLinkProvider } from "@/lib/markdown/channel-link-context"
import type { Mentionable } from "@/components/editor/triggers/types"
import { MarkdownContent } from "./markdown-content"

// MarkdownLink intercepts same-origin links through useNavigate, which requires
// a Router context. Wrap every render with MemoryRouter so existing tests
// continue to exercise the real component tree. rerender is wrapped too so
// the memoization test stays a true rerender of the same root.
const render = (ui: ReactElement) => {
  const result = rtlRender(<MemoryRouter>{ui}</MemoryRouter>)
  return {
    ...result,
    rerender: (next: ReactElement) => result.rerender(<MemoryRouter>{next}</MemoryRouter>),
  }
}

describe("MarkdownContent", () => {
  describe("basic text formatting", () => {
    it("should render plain text", () => {
      render(<MarkdownContent content="Hello world" />)
      expect(screen.getByText("Hello world")).toBeInTheDocument()
    })

    it("should render bold text", () => {
      render(<MarkdownContent content="**bold text**" />)
      const bold = screen.getByText("bold text")
      expect(bold.tagName).toBe("STRONG")
      expect(bold).toHaveClass("font-semibold")
    })

    it("should render italic text", () => {
      render(<MarkdownContent content="*italic text*" />)
      const italic = screen.getByText("italic text")
      expect(italic.tagName).toBe("EM")
      expect(italic).toHaveClass("italic")
    })

    it("should render strikethrough text", () => {
      render(<MarkdownContent content="~~deleted~~" />)
      const del = screen.getByText("deleted")
      expect(del.tagName).toBe("DEL")
      expect(del).toHaveClass("line-through")
    })

    it("should render combined formatting", () => {
      render(<MarkdownContent content="***bold and italic***" />)
      const text = screen.getByText("bold and italic")
      // Should be wrapped in both strong and em
      expect(text.closest("strong")).toBeInTheDocument()
      expect(text.closest("em")).toBeInTheDocument()
    })
  })

  describe("headers", () => {
    it("should render h1", () => {
      render(<MarkdownContent content="# Heading 1" />)
      const h1 = screen.getByRole("heading", { level: 1 })
      expect(h1).toHaveTextContent("Heading 1")
      expect(h1).toHaveClass("text-xl", "font-bold")
    })

    it("should render h2", () => {
      render(<MarkdownContent content="## Heading 2" />)
      const h2 = screen.getByRole("heading", { level: 2 })
      expect(h2).toHaveTextContent("Heading 2")
      expect(h2).toHaveClass("text-lg", "font-bold")
    })

    it("should render h3", () => {
      render(<MarkdownContent content="### Heading 3" />)
      const h3 = screen.getByRole("heading", { level: 3 })
      expect(h3).toHaveTextContent("Heading 3")
      expect(h3).toHaveClass("text-base", "font-semibold")
    })

    it("should render h4", () => {
      render(<MarkdownContent content="#### Heading 4" />)
      const h4 = screen.getByRole("heading", { level: 4 })
      expect(h4).toHaveTextContent("Heading 4")
      expect(h4).toHaveClass("text-sm", "font-semibold")
    })

    it("should render h5", () => {
      render(<MarkdownContent content="##### Heading 5" />)
      const h5 = screen.getByRole("heading", { level: 5 })
      expect(h5).toHaveTextContent("Heading 5")
      expect(h5).toHaveClass("text-sm", "font-medium")
    })

    it("should render h6", () => {
      render(<MarkdownContent content="###### Heading 6" />)
      const h6 = screen.getByRole("heading", { level: 6 })
      expect(h6).toHaveTextContent("Heading 6")
      expect(h6).toHaveClass("text-sm", "font-medium", "text-muted-foreground")
    })
  })

  describe("links", () => {
    it("should render markdown links", () => {
      render(<MarkdownContent content="[Click here](https://example.com)" />)
      const link = screen.getByRole("link", { name: "Click here" })
      expect(link).toHaveAttribute("href", "https://example.com")
    })

    it("should open links in new tab", () => {
      render(<MarkdownContent content="[Link](https://example.com)" />)
      const link = screen.getByRole("link")
      expect(link).toHaveAttribute("target", "_blank")
      expect(link).toHaveAttribute("rel", "noopener noreferrer")
    })

    it("should style links with primary color", () => {
      render(<MarkdownContent content="[Link](https://example.com)" />)
      const link = screen.getByRole("link")
      expect(link).toHaveClass("text-primary", "underline")
    })

    it("should auto-linkify bare URLs", () => {
      render(<MarkdownContent content="Visit https://example.com for more" />)
      const link = screen.getByRole("link")
      expect(link).toHaveAttribute("href", "https://example.com")
      expect(link).toHaveTextContent("https://example.com")
    })

    it("should auto-linkify www URLs", () => {
      render(<MarkdownContent content="Visit www.example.com today" />)
      const link = screen.getByRole("link")
      expect(link).toHaveAttribute("href", "http://www.example.com")
    })

    it("should keep same-origin links in-app instead of opening a new tab", () => {
      const internalUrl = `${window.location.origin}/w/ws_1/s/stream_1?m=msg_1`
      render(<MarkdownContent content={`See [the message](${internalUrl})`} />)
      const link = screen.getByRole("link", { name: "the message" })
      expect(link).toHaveAttribute("href", internalUrl)
      expect(link).not.toHaveAttribute("target")
      expect(link).not.toHaveAttribute("rel")
    })

    it("should still open cross-origin links in a new tab", () => {
      render(<MarkdownContent content="[outside](https://example.com/x)" />)
      const link = screen.getByRole("link", { name: "outside" })
      expect(link).toHaveAttribute("target", "_blank")
      expect(link).toHaveAttribute("rel", "noopener noreferrer")
    })
  })

  describe("mention/channel pointer links (INV-64)", () => {
    const MENTIONABLES: Mentionable[] = [
      { id: "usr_1", slug: "pierre", name: "Pierre", type: "user" },
      { id: "usr_me", slug: "self", name: "Me", type: "user", isCurrentUser: true },
      { id: "persona_1", slug: "ariadne", name: "Ariadne", type: "persona" },
      { id: "bot_own", slug: "my-bot", name: "My Bot", type: "bot" },
      { id: "bot_theirs", slug: "kris-bot", name: "Kris's Bot", type: "bot", mentionOnly: true },
    ]
    const STREAMS = [
      { id: "stream_1", type: StreamTypes.CHANNEL, slug: "general" },
      { id: "stream_2", type: StreamTypes.SCRATCHPAD, slug: null, displayName: "Pi remote control" },
    ]

    const renderPointer = (content: string, onMentionClick?: (slug: string, type: MentionType, id?: string) => void) =>
      render(
        <MentionProvider mentionables={MENTIONABLES} onMentionClick={onMentionClick}>
          <ChannelLinkProvider workspaceId="ws_1" streams={STREAMS}>
            <MarkdownContent content={content} />
          </ChannelLinkProvider>
        </MentionProvider>
      )

    it("renders a user mention pointer as a chip, not a broken link", () => {
      renderPointer("Hey [@pierre](user:usr_1)")
      expect(screen.getByText("@pierre")).toBeInTheDocument()
      expect(screen.queryByRole("link", { name: "@pierre" })).not.toBeInTheDocument()
    })

    it("colors a persona mention from the scheme, not the slug→type default", () => {
      renderPointer("[@ariadne](persona:persona_1)")
      // triggerStyles.persona — distinct from the user/blue styling the bare-slug
      // fallback would have applied if the slug weren't in the mentionables map.
      expect(screen.getByText("@ariadne")).toHaveClass("text-primary")
    })

    it("renders a channel pointer as a link to the stream by id", () => {
      renderPointer("See [#general](channel:stream_1)")
      const link = screen.getByRole("link", { name: "#general" })
      expect(link).toHaveAttribute("href", "/w/ws_1/s/stream_1")
    })

    it("renders an unknown/inaccessible channel id as plain text, not a dead link", () => {
      renderPointer("[#ghost](channel:stream_unknown)")
      expect(screen.getByText("#ghost")).toBeInTheDocument()
      expect(screen.queryByRole("link", { name: "#ghost" })).not.toBeInTheDocument()
    })

    it("names a scratchpad pointer, dropping the folded slug for the real title", () => {
      renderPointer("See [#pi-remote-control](channel:stream_2)")
      expect(screen.getByRole("link", { name: "Pi remote control" })).toHaveAttribute("href", "/w/ws_1/s/stream_2")
      expect(screen.queryByText("#pi-remote-control")).not.toBeInTheDocument()
    })

    it("relabels a renamed target from the id, not the slug frozen at authoring time", () => {
      renderPointer("See [#old-name](channel:stream_2)")
      expect(screen.getByRole("link", { name: "Pi remote control" })).toBeInTheDocument()
      expect(screen.queryByText("#old-name")).not.toBeInTheDocument()
    })

    it("keeps the authored label for a target the viewer has no cached row for", () => {
      renderPointer("[#ghost](channel:stream_unknown)")
      expect(screen.getByText("#ghost")).toBeInTheDocument()
    })

    it("navigates a user mention by the embedded id, not the slug", () => {
      const onMentionClick = vi.fn()
      renderPointer("[@pierre](user:usr_1)", onMentionClick)
      fireEvent.click(screen.getByText("@pierre"))
      expect(onMentionClick).toHaveBeenCalledWith("pierre", "user", "usr_1")
    })

    it("upgrades the current user's own mention to the 'me' styling", () => {
      renderPointer("[@self](user:usr_me)")
      expect(screen.getByText("@self")).toHaveClass("font-semibold")
    })

    it("marks another user's personal bot mention as mention-only (won't invoke)", () => {
      renderPointer("[@kris-bot](bot:bot_theirs)")
      const chip = screen.getByText("@kris-bot")
      expect(chip).toHaveClass("decoration-dashed")
      expect(chip).toHaveAttribute("title", expect.stringContaining("only its owner can invoke"))
    })

    it("renders an invocable bot mention without the mention-only signal", () => {
      renderPointer("[@my-bot](bot:bot_own)")
      const chip = screen.getByText("@my-bot")
      expect(chip).not.toHaveClass("decoration-dashed")
      expect(chip).not.toHaveAttribute("title")
    })

    it("chips a bare slug only when it names someone in the roster", () => {
      renderPointer("Ping @pierre and @nobody in #general and #nowhere")
      expect(screen.getByText("@pierre")).toHaveClass("rounded")
      expect(screen.getByRole("link", { name: "#general" })).toHaveAttribute("href", "/w/ws_1/s/stream_1")
      expect(screen.queryByText("@nobody")).not.toBeInTheDocument()
      expect(screen.queryByText("#nowhere")).not.toBeInTheDocument()
      expect(screen.getByText(/@nobody in/)).toBeInTheDocument()
    })
  })

  describe("code", () => {
    it("should render inline code", () => {
      render(<MarkdownContent content="Use `const x = 1` here" />)
      const code = screen.getByText("const x = 1")
      expect(code.tagName).toBe("CODE")
      expect(code).toHaveClass("bg-muted", "font-mono")
    })

    it("should render code blocks with language", () => {
      const content = "```typescript\nconst x: number = 1\n```"
      render(<MarkdownContent content={content} />)
      // Code blocks render in a pre element with Suspense fallback initially
      const pre = document.querySelector("pre")
      expect(pre).toBeInTheDocument()
      expect(pre).toHaveTextContent("const x: number = 1")
    })

    it("should render code blocks without language as inline code", () => {
      // Code blocks without language tag are treated as inline code
      const content = "```\nplain code\n```"
      render(<MarkdownContent content={content} />)
      const code = screen.getByText(/plain code/)
      expect(code.tagName).toBe("CODE")
    })
  })

  describe("lists", () => {
    it("should render unordered lists", () => {
      const content = "- Item 1\n- Item 2\n- Item 3"
      render(<MarkdownContent content={content} />)
      const list = screen.getByRole("list")
      expect(list.tagName).toBe("UL")
      expect(list).toHaveClass("list-disc")
      expect(screen.getAllByRole("listitem")).toHaveLength(3)
    })

    it("should render ordered lists", () => {
      const content = "1. First\n2. Second\n3. Third"
      render(<MarkdownContent content={content} />)
      const list = screen.getByRole("list")
      expect(list.tagName).toBe("OL")
      expect(list).toHaveClass("list-decimal")
    })

    it("should render nested lists", () => {
      const content = "- Parent\n  - Child 1\n  - Child 2"
      render(<MarkdownContent content={content} />)
      const lists = screen.getAllByRole("list")
      expect(lists.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("blockquotes", () => {
    it("should render blockquotes", () => {
      render(<MarkdownContent content="> This is a quote" />)
      const blockquote = screen.getByText("This is a quote").closest("blockquote")
      expect(blockquote).toBeInTheDocument()
      expect(blockquote).toHaveClass("border-l-2", "border-primary/50")
    })

    it("should render nested blockquotes", () => {
      const content = "> Outer\n>> Inner"
      render(<MarkdownContent content={content} />)
      const blockquotes = document.querySelectorAll("blockquote")
      expect(blockquotes.length).toBe(2)
    })

    it("keeps each quoted line on its own line", () => {
      render(<MarkdownContent content={"> bla\n> *bla*\n> bla"} />)
      const paragraph = document.querySelector("blockquote p")
      expect({ breaks: paragraph?.querySelectorAll("br").length, text: paragraph?.textContent }).toEqual({
        breaks: 2,
        text: "bla\nbla\nbla",
      })
    })
  })

  describe("tables (GFM)", () => {
    it("should render tables", () => {
      const content = `| Header 1 | Header 2 |
| -------- | -------- |
| Cell 1   | Cell 2   |`
      render(<MarkdownContent content={content} />)
      expect(screen.getByRole("table")).toBeInTheDocument()
      expect(screen.getByText("Header 1")).toBeInTheDocument()
      expect(screen.getByText("Cell 1")).toBeInTheDocument()
    })

    it("should use Shadcn table components", () => {
      const content = `| A | B |
| - | - |
| 1 | 2 |`
      render(<MarkdownContent content={content} />)
      const table = screen.getByRole("table")
      // Shadcn Table wraps in a div with overflow-auto class
      expect(table.parentElement).toHaveClass("overflow-auto")
    })
  })

  describe("task lists (GFM)", () => {
    it("should render task lists with checkboxes", () => {
      const content = "- [ ] Unchecked\n- [x] Checked"
      render(<MarkdownContent content={content} />)
      const checkboxes = screen.getAllByRole("checkbox")
      expect(checkboxes).toHaveLength(2)
    })

    it("should render checkboxes as disabled (read-only)", () => {
      const content = "- [ ] Task"
      render(<MarkdownContent content={content} />)
      const checkbox = screen.getByRole("checkbox")
      expect(checkbox).toBeDisabled()
    })

    it("should reflect checked state", () => {
      const content = "- [x] Done task"
      render(<MarkdownContent content={content} />)
      const checkbox = screen.getByRole("checkbox")
      expect(checkbox).toHaveAttribute("data-state", "checked")
    })
  })

  describe("images", () => {
    it("should render images as links", () => {
      render(<MarkdownContent content="![Alt text](https://example.com/image.png)" />)
      const link = screen.getByRole("link")
      expect(link).toHaveAttribute("href", "https://example.com/image.png")
    })

    it("should use alt text as link text when provided", () => {
      render(<MarkdownContent content="![My image](https://example.com/img.png)" />)
      const link = screen.getByRole("link")
      expect(link).toHaveTextContent("My image")
    })

    it("should use URL as link text when no alt text", () => {
      render(<MarkdownContent content="![](https://example.com/img.png)" />)
      const link = screen.getByRole("link")
      expect(link).toHaveTextContent("https://example.com/img.png")
    })

    it("should open image links in new tab", () => {
      render(<MarkdownContent content="![img](https://example.com/img.png)" />)
      const link = screen.getByRole("link")
      expect(link).toHaveAttribute("target", "_blank")
      expect(link).toHaveAttribute("rel", "noopener noreferrer")
    })
  })

  describe("horizontal rules", () => {
    it("should render horizontal rules", () => {
      // Thematic breaks require proper markdown formatting
      const content = `First paragraph

---

Second paragraph`
      render(<MarkdownContent content={content} />)
      const hr = document.querySelector("hr")
      expect(hr).toBeInTheDocument()
      expect(hr).toHaveClass("border-border")
    })
  })

  describe("security", () => {
    it("should not render raw HTML", () => {
      render(<MarkdownContent content="<script>alert('xss')</script>" />)
      expect(document.querySelector("script")).not.toBeInTheDocument()
      // The text content should be visible but not executed
      expect(screen.queryByText(/alert/)).toBeInTheDocument()
    })

    it("should not render dangerous HTML tags", () => {
      render(<MarkdownContent content="<iframe src='evil.com'></iframe>" />)
      expect(document.querySelector("iframe")).not.toBeInTheDocument()
    })

    it("renders a linked image as the link, never an anchor inside an anchor", () => {
      render(<MarkdownContent content="[![build status](https://img.example/badge.svg)](https://ci.example/runs)" />)
      const link = screen.getByRole("link", { name: "build status" })
      expect({ href: link.getAttribute("href"), nested: link.querySelector("a") }).toEqual({
        href: "https://ci.example/runs",
        nested: null,
      })
    })

    it("labels an alt-less linked image with its source", () => {
      render(<MarkdownContent content="[![](https://img.example/badge.svg)](https://ci.example/runs)" />)
      expect(screen.getByRole("link", { name: "https://img.example/badge.svg" })).toHaveAttribute(
        "href",
        "https://ci.example/runs"
      )
    })

    it("should escape HTML in inline content", () => {
      render(<MarkdownContent content="<div>test</div>" />)
      expect(document.querySelector("div.markdown-content div > div")).not.toBeInTheDocument()
    })
  })

  describe("embedded HTML (allowHtml)", () => {
    // What third-party HTML could use to run code, load remote content, restyle
    // the app, clobber globals, or pose as a Threa pointer. Tag and attribute
    // checks skip KaTeX output, which styles its own spans and draws with
    // svg/MathML; links are checked everywhere. The <kbd> marker proves the HTML
    // was parsed at all, so a payload escaped to text cannot pass vacuously.
    const exposure = (container: HTMLElement) => {
      const outsideKatex = (selector: string) =>
        [...container.querySelectorAll(selector)].filter((el) => !el.closest(".katex"))
      const all = outsideKatex("*")
      return {
        htmlRendered: container.querySelector("kbd") !== null,
        elements: outsideKatex(
          "script,iframe,frame,object,embed,form,video,audio,source,track,style,link,meta,base,svg,math,noscript,template"
        ).map((el) => el.tagName.toLowerCase()),
        handlers: all.flatMap((el) => el.getAttributeNames().filter((name) => name.startsWith("on"))),
        styled: outsideKatex("[style]").map((el) => el.tagName.toLowerCase()),
        remoteLoads: outsideKatex("[src],[srcset],[poster],[data],[action],[formaction],[background]").map((el) =>
          el.tagName.toLowerCase()
        ),
        unsafeHrefs: [...container.querySelectorAll("[href]")]
          .map((el) => el.getAttribute("href") ?? "")
          .filter((href) => !/^(https?:|mailto:|\/|#|$)/i.test(href)),
        katexLinks: [...container.querySelectorAll(".katex [href]")].map((el) => el.getAttribute("href")),
        unprefixedIds: outsideKatex("[id],[name]")
          .flatMap((el) => [el.getAttribute("id"), el.getAttribute("name")])
          .filter((value): value is string => value !== null && !value.startsWith("user-content-")),
      }
    }
    const safe = {
      htmlRendered: true,
      elements: [],
      handlers: [],
      styled: [],
      remoteLoads: [],
      unsafeHrefs: [],
      katexLinks: [],
      unprefixedIds: [],
    }

    it.each([
      ["script", "<script>alert(1)</script>"],
      ["script inside svg", "<svg><script>alert(1)</script></svg>"],
      ["img onerror", "<img src=x onerror=alert(1)>"],
      ["event handler attributes", '<div onclick="alert(1)" onmouseover="alert(1)">x</div>'],
      ["javascript: href", '<a href="javascript:alert(1)">x</a>'],
      ["entity-obfuscated javascript: href", '<a href="JaVaScRiPt&#58;alert(1)">x</a>'],
      ["tab-obfuscated javascript: href", '<a href="java&#9;script:alert(1)">x</a>'],
      ["markdown javascript: link", "[x](javascript:alert(1))"],
      ["vbscript: href", '<a href="vbscript:msgbox(1)">x</a>'],
      ["data: href", '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'],
      ["embeds", '<iframe src="https://evil.example"></iframe><object data="https://evil.example/x"></object>'],
      [
        "embed and form",
        '<embed src="https://evil.example/x"><form action="https://evil.example"><button formaction="https://evil.example">go</button></form>',
      ],
      [
        "media",
        '<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"></video><audio src="https://evil.example/a.mp3"></audio>',
      ],
      [
        "picture source",
        '<picture><source srcset="https://evil.example/t.png"><img src="https://evil.example/t.png" alt="t"></picture>',
      ],
      [
        "style attribute and sheets",
        '<p style="position:fixed;inset:0">x</p><style>body{display:none}</style><link rel="stylesheet" href="https://evil.example/x.css">',
      ],
      [
        "meta refresh and base",
        '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">',
      ],
      [
        "DOM clobbering ids",
        '<a id="__proto__" name="location" href="https://ok.example">x</a><img name="getElementById" alt="y" src="https://a.example/y.png">',
      ],
      ["mXSS through noscript", '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
      ["mXSS through math", "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>"],
      [
        "pointer protocols",
        '<a href="user:usr_1">@kris</a> [m](memo:memo_1) [a](attachment:attach_1) [s](shared-message:stream_1/msg_1) [g](giphy:abc) [c](channel:stream_1)',
      ],
      ["KaTeX href", "$\\href{javascript:alert(1)}{x}$ and $\\href{/w/ws_1}{y}$"],
    ])("neutralizes %s", (_label, payload) => {
      const { container } = render(<MarkdownContent content={`<kbd>html</kbd> on\n\n${payload}`} allowHtml />)
      expect(exposure(container)).toEqual(safe)
    })

    it.each([
      ["math inside an HTML block as its TeX", "<p>Inline $x^2$ here</p>", "Inline $x^2$ here"],
      ["a <pre> with no <code>", "<pre>( o.o )\n > ^ <</pre>", "( o.o )\n > ^ <"],
      ["markup inside <pre><code>", "<pre><code>a <b>b</b> c</code></pre>", "a b c"],
    ])("keeps the text of %s", (_label, content, text) => {
      const { container } = render(<MarkdownContent content={content} allowHtml />)
      expect(container.textContent).toContain(text)
    })
  })

  describe("edge cases", () => {
    it("should handle empty content", () => {
      const { container } = render(<MarkdownContent content="" />)
      expect(container.querySelector(".markdown-content")).toBeInTheDocument()
    })

    it("should handle content with only whitespace", () => {
      const { container } = render(<MarkdownContent content="   \n\n   " />)
      expect(container.querySelector(".markdown-content")).toBeInTheDocument()
    })

    it("should handle very long single lines", () => {
      const longLine = "a".repeat(10000)
      render(<MarkdownContent content={longLine} />)
      expect(screen.getByText(longLine)).toBeInTheDocument()
    })

    it("should handle deeply nested content", () => {
      const content = "> > > > Deeply nested quote"
      render(<MarkdownContent content={content} />)
      expect(screen.getByText("Deeply nested quote")).toBeInTheDocument()
    })

    it("should handle mixed content", () => {
      const content = `# Header

Some **bold** and *italic* text with \`code\`.

- List item 1
- List item 2

> A quote

| A | B |
|---|---|
| 1 | 2 |`
      render(<MarkdownContent content={content} />)
      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument()
      expect(screen.getByText("bold")).toBeInTheDocument()
      expect(screen.getByText("code")).toBeInTheDocument()
      expect(screen.getByRole("list")).toBeInTheDocument()
      expect(document.querySelector("blockquote")).toBeInTheDocument()
      expect(screen.getByRole("table")).toBeInTheDocument()
    })
  })

  describe("className prop", () => {
    it("should apply custom className", () => {
      const { container } = render(<MarkdownContent content="test" className="custom-class" />)
      expect(container.querySelector(".markdown-content")).toHaveClass("custom-class")
    })

    it("should merge with default markdown-content class", () => {
      const { container } = render(<MarkdownContent content="test" className="my-class" />)
      const wrapper = container.querySelector(".markdown-content")
      expect(wrapper).toHaveClass("markdown-content")
      expect(wrapper).toHaveClass("my-class")
    })
  })

  describe("overflow handling", () => {
    it("should wrap long unbreakable strings inside the content column", () => {
      const { container } = render(<MarkdownContent content="test" />)
      const wrapper = container.querySelector(".markdown-content")
      expect(wrapper).toHaveClass("break-words")
      expect(wrapper).toHaveClass("min-w-0")
    })

    it("should break long autolinked URLs at arbitrary points", () => {
      const longUrl = "https://example.com/" + "averyverylongsegment".repeat(20)
      render(<MarkdownContent content={longUrl} />)
      const link = screen.getByRole("link")
      // break-all allows breaking unbreakable URL text mid-token.
      expect(link).toHaveClass("break-all")
    })

    it("should break long inline code at arbitrary points", () => {
      const longToken = "a".repeat(200)
      render(<MarkdownContent content={"Use `" + longToken + "` here"} />)
      const code = screen.getByText(longToken)
      expect(code.tagName).toBe("CODE")
      expect(code).toHaveClass("break-all")
    })
  })

  describe("math", () => {
    // KaTeX round-trips the source into a MathML <annotation>, so this reads the
    // TeX the renderer actually parsed rather than its glyph layout.
    const renderedTex = (container: HTMLElement) =>
      [...container.querySelectorAll("annotation[encoding='application/x-tex']")].map((node) => node.textContent)

    it("should render inline math between single dollars", () => {
      const { container } = render(<MarkdownContent content={"Euler: $e^{i\\pi} + 1 = 0$ nice"} />)
      expect(renderedTex(container)).toEqual(["e^{i\\pi} + 1 = 0"])
      expect(container.querySelector(".katex-display")).toBeNull()
      // The sentence around the equation has to survive the text-node splice.
      expect(container.textContent).toContain("Euler:")
      expect(container.textContent).toContain("nice")
    })

    it("should keep the TeX escapes CommonMark would eat", () => {
      const { container } = render(<MarkdownContent content={"\\[ \\{x\\} \\\\ 50\\% \\]"} />)
      expect(renderedTex(container)).toEqual(["\\{x\\} \\\\ 50\\%"])
    })

    it("should keep a body CommonMark emphasis would split", () => {
      const { container } = render(<MarkdownContent content={"$x^*$ and $y^*$"} />)
      expect(renderedTex(container)).toEqual(["x^*", "y^*"])
      expect(container.querySelector("em")).toBeNull()
    })

    it("should bound the size of user-specified lengths", () => {
      const { container } = render(<MarkdownContent content={"$\\rule{1em}{200em}$"} />)
      const rule = container.querySelector<HTMLElement>(".mord.rule")
      expect(rule?.style.borderTopWidth).toBe("10em")
    })

    it("should render display math between double dollars", () => {
      const { container } = render(<MarkdownContent content={"$$\n\\frac{9}{31}\n$$"} />)
      expect(renderedTex(container)).toEqual(["\\frac{9}{31}"])
      expect(container.querySelector(".katex-display")).not.toBeNull()
    })

    it("should render the backslash delimiters LLM answers arrive in", () => {
      const { container } = render(<MarkdownContent content={"\\[\n\n0.31 + 0.31w > 0.40\n\n\\]"} />)
      expect(renderedTex(container)).toEqual(["0.31 + 0.31w > 0.40"])
      expect(container.querySelector(".katex-display")).not.toBeNull()
    })

    it("should render every equation in a run of display blocks", () => {
      const answer = [
        "at least about **29% as much as his own**:",
        "\\[\n\n0.31 + 0.31w > 0.40\n\n\\]",
        "\\[\n\n0.31w > 0.09\n\n\\]",
        "\\[\n\nw > \\frac{9}{31} \\approx 0.29\n\n\\]",
      ].join("\n\n")
      const { container } = render(<MarkdownContent content={answer} />)
      expect(renderedTex(container)).toEqual(["0.31 + 0.31w > 0.40", "0.31w > 0.09", "w > \\frac{9}{31} \\approx 0.29"])
    })

    it("should render inline backslash delimiters", () => {
      const { container } = render(<MarkdownContent content={"inline \\( x^2 \\) here"} />)
      expect(renderedTex(container)).toEqual(["x^2"])
      expect(container.querySelector(".katex-display")).toBeNull()
    })

    it("should render math inside a table cell", () => {
      const { container } = render(<MarkdownContent content={"| a | b |\n|---|---|\n| $x^2$ | 2 |"} />)
      expect(renderedTex(container)).toEqual(["x^2"])
    })

    it("should surface unparseable TeX instead of dropping it", () => {
      const { container } = render(<MarkdownContent content={"broken $\\frac{1}{x$ oops"} />)
      const error = container.querySelector(".katex-error")
      expect(error).not.toBeNull()
      expect(error).toHaveTextContent("\\frac{1}{x")
      expect(error?.getAttribute("title")).toContain("KaTeX parse error")
    })

    it("should leave prices as text", () => {
      const { container } = render(<MarkdownContent content="costs $5 and $10 total" />)
      expect(renderedTex(container)).toEqual([])
      expect(screen.getByText("costs $5 and $10 total")).toBeInTheDocument()
    })

    it("should leave dollars inside code alone", () => {
      const { container } = render(<MarkdownContent content="run `echo $HOME` and $PATH" />)
      expect(renderedTex(container)).toEqual([])
      expect(screen.getByText("echo $HOME").tagName).toBe("CODE")
    })
  })

  describe("memoization", () => {
    it("should be memoized to prevent unnecessary re-renders", () => {
      const { rerender } = render(<MarkdownContent content="test" />)
      const firstRender = screen.getByText("test")

      rerender(<MarkdownContent content="test" />)
      const secondRender = screen.getByText("test")

      // Same content should result in same DOM node
      expect(firstRender).toBe(secondRender)
    })
  })
})
