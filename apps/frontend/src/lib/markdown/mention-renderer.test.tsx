import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { StreamTypes } from "@threahq/types"
import { renderMentions, processChildrenForMentions } from "./mention-renderer"
import { ChannelLinkProvider } from "./channel-link-context"

// No-op emoji lookup for mention tests (not testing emoji rendering here)
const noEmoji = () => null

describe("mention-renderer", () => {
  describe("renderMentions", () => {
    it("should return plain text when no mentions or channels", () => {
      const result = renderMentions("Hello world", noEmoji)

      expect(result).toHaveLength(1)
      expect(result[0]).toBe("Hello world")
    })

    it("should parse single @mention", () => {
      const result = renderMentions("Hey @kristoffer!", noEmoji)

      expect(result).toHaveLength(3)
      expect(result[0]).toBe("Hey ")
      expect(result[2]).toBe("!")
    })

    it("should parse single #channel", () => {
      const result = renderMentions("Check #general", noEmoji)

      expect(result).toHaveLength(2)
      expect(result[0]).toBe("Check ")
    })

    it("should parse multiple mentions", () => {
      const result = renderMentions("@alice and @bob", noEmoji)

      expect(result).toHaveLength(3)
      expect(result[1]).toBe(" and ")
    })

    it("should parse mixed mentions and channels", () => {
      const result = renderMentions("@kristoffer in #engineering", noEmoji)

      expect(result).toHaveLength(3)
      expect(result[1]).toBe(" in ")
    })

    it("should handle mention at start of text", () => {
      const result = renderMentions("@kristoffer", noEmoji)

      expect(result).toHaveLength(1)
    })

    it("should handle channel at end of text", () => {
      const result = renderMentions("See #general", noEmoji)

      expect(result).toHaveLength(2)
      expect(result[0]).toBe("See ")
    })

    it("should handle mentions with hyphens", () => {
      const result = renderMentions("@kristoffer-remback", noEmoji)

      expect(result).toHaveLength(1)
    })

    it("should parse channels with underscores", () => {
      const result = renderMentions("#dev_team", noEmoji)

      expect(result).toHaveLength(1)
    })

    it("should render mention chip with correct type styling", () => {
      const result = renderMentions("@kristoffer", noEmoji)
      render(<>{result}</>)

      const chip = screen.getByText(/@kristoffer/)
      expect(chip).toBeInTheDocument()
      expect(chip.className).toContain("bg-[hsl(200")
    })

    it("should render channel chip with correct styling", () => {
      const result = renderMentions("#general", noEmoji)
      render(<>{result}</>)

      const chip = screen.getByText(/#general/)
      expect(chip).toBeInTheDocument()
      expect(chip.className).toContain("bg-muted")
    })

    it("should render broadcast mentions with orange styling", () => {
      const result = renderMentions("@channel", noEmoji)
      render(<>{result}</>)

      const chip = screen.getByText(/@channel/)
      expect(chip).toBeInTheDocument()
      expect(chip.className).toContain("bg-orange")
    })

    it("should render @here as broadcast", () => {
      const result = renderMentions("@here", noEmoji)
      render(<>{result}</>)

      const chip = screen.getByText(/@here/)
      expect(chip).toBeInTheDocument()
      expect(chip.className).toContain("bg-orange")
    })

    it("should not parse email addresses as mentions", () => {
      const result = renderMentions("Contact test@example.com", noEmoji)

      // Email addresses should NOT extract mentions (@ preceded by alphanumeric)
      expect(result).toHaveLength(1)
      expect(result[0]).toBe("Contact test@example.com")
    })

    it("should handle empty string", () => {
      const result = renderMentions("", noEmoji)

      expect(result).toHaveLength(1)
      expect(result[0]).toBe("")
    })

    it("should handle text with no valid trigger characters", () => {
      const result = renderMentions("Just plain text here", noEmoji)

      expect(result).toHaveLength(1)
      expect(result[0]).toBe("Just plain text here")
    })
  })

  describe("processChildrenForMentions", () => {
    it("should process string children", () => {
      const result = processChildrenForMentions("Hey @kristoffer", noEmoji)
      render(<div data-testid="container">{result}</div>)

      expect(screen.getByText(/@kristoffer/)).toBeInTheDocument()
    })

    it("should pass through non-string children unchanged", () => {
      const element = <span>Not a string</span>
      const result = processChildrenForMentions(element, noEmoji)

      expect(result).toBe(element)
    })

    it("should process array children", () => {
      const children = ["Hey ", "@kristoffer", " check this"]
      const result = processChildrenForMentions(children, noEmoji)
      render(<div data-testid="container">{result}</div>)

      expect(screen.getByText(/@kristoffer/)).toBeInTheDocument()
    })

    it("should handle null children", () => {
      const result = processChildrenForMentions(null, noEmoji)
      expect(result).toBeNull()
    })

    it("should handle undefined children", () => {
      const result = processChildrenForMentions(undefined, noEmoji)
      expect(result).toBeUndefined()
    })

    it("should handle number children", () => {
      const result = processChildrenForMentions(42, noEmoji)
      expect(result).toBe(42)
    })

    it("should handle boolean children", () => {
      const result = processChildrenForMentions(true, noEmoji)
      expect(result).toBe(true)
    })
  })

  describe("MentionChip rendering", () => {
    it("should render @ prefix for mentions", () => {
      const result = renderMentions("@kristoffer", noEmoji)
      render(<>{result}</>)

      expect(screen.getByText(/@kristoffer/)).toBeInTheDocument()
    })

    it("should render # prefix for channels", () => {
      const result = renderMentions("#general", noEmoji)
      render(<>{result}</>)

      expect(screen.getByText(/#general/)).toBeInTheDocument()
    })

    it("should have proper inline styling", () => {
      const result = renderMentions("@kristoffer", noEmoji)
      render(<>{result}</>)

      const chip = screen.getByText(/@kristoffer/)
      expect(chip.className).toContain("inline")
      expect(chip.className).toContain("rounded")
    })

    it("should render multiple chips in sequence", () => {
      const result = renderMentions("@alice @bob @charlie", noEmoji)
      render(<>{result}</>)

      expect(screen.getByText(/@alice/)).toBeInTheDocument()
      expect(screen.getByText(/@bob/)).toBeInTheDocument()
      expect(screen.getByText(/@charlie/)).toBeInTheDocument()
    })
  })

  describe("channel link rendering", () => {
    const streams = [
      { id: "stream_abc", type: StreamTypes.CHANNEL, slug: "general" },
      { id: "stream_def", type: StreamTypes.CHANNEL, slug: "engineering" },
      { id: "stream_ghi", type: StreamTypes.SCRATCHPAD, slug: null },
    ]

    function renderWithChannelLinks(text: string) {
      const result = renderMentions(text, noEmoji)
      return render(
        <MemoryRouter>
          <ChannelLinkProvider workspaceId="workspace_123" streams={streams}>
            <>{result}</>
          </ChannelLinkProvider>
        </MemoryRouter>
      )
    }

    it("should render known channel as a link", () => {
      renderWithChannelLinks("Check #general")

      const link = screen.getByRole("link", { name: /#general/ })
      expect(link).toBeInTheDocument()
      expect(link).toHaveAttribute("href", "/w/workspace_123/s/stream_abc")
    })

    it("should render unknown channel as inert span", () => {
      renderWithChannelLinks("Check #nonexistent")

      const chip = screen.getByText(/#nonexistent/)
      expect(chip.tagName).toBe("SPAN")
      expect(chip).not.toHaveAttribute("href")
    })

    it("should render multiple channel links", () => {
      renderWithChannelLinks("#general and #engineering")

      const generalLink = screen.getByRole("link", { name: /#general/ })
      const engineeringLink = screen.getByRole("link", { name: /#engineering/ })
      expect(generalLink).toHaveAttribute("href", "/w/workspace_123/s/stream_abc")
      expect(engineeringLink).toHaveAttribute("href", "/w/workspace_123/s/stream_def")
    })

    it("should not link non-channel stream types", () => {
      renderWithChannelLinks("#general")

      const links = screen.getAllByRole("link")
      expect(links).toHaveLength(1)
    })
  })

  describe("edge cases", () => {
    it("should handle consecutive mentions without space", () => {
      // @alice@bob - the second @ is preceded by alphanumeric, so only @alice is extracted
      const result = renderMentions("@alice@bob", noEmoji)

      expect(result).toHaveLength(2)
      render(<>{result}</>)

      expect(screen.getByText(/@alice/)).toBeInTheDocument()
      // @bob is NOT extracted because @ is preceded by 'e' (no word boundary)
      expect(result[1]).toBe("@bob")
    })

    it("should handle mention followed by channel", () => {
      // @alice#general - # preceded by 'e' so #general is NOT extracted
      const result = renderMentions("@alice#general", noEmoji)

      expect(result).toHaveLength(2)
      render(<>{result}</>)

      expect(screen.getByText(/@alice/)).toBeInTheDocument()
      expect(result[1]).toBe("#general") // Not extracted, returned as plain text
    })

    it("should handle very long slugs", () => {
      const longSlug = "a".repeat(50)
      const result = renderMentions(`@${longSlug}`, noEmoji)
      render(<>{result}</>)

      expect(screen.getByText(new RegExp(`@${longSlug}`))).toBeInTheDocument()
    })

    it("should handle slugs with numbers", () => {
      const result = renderMentions("@user123", noEmoji)
      render(<>{result}</>)

      expect(screen.getByText(/@user123/)).toBeInTheDocument()
    })

    it("should stop at punctuation", () => {
      const result = renderMentions("@kristoffer, please check", noEmoji)

      expect(result).toHaveLength(2)
      expect(result[1]).toBe(", please check")
    })

    it("should handle newlines in input", () => {
      const result = renderMentions("@alice\n@bob", noEmoji)

      // Newline is not a word character, so each mention is separate
      expect(result.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("slash command rendering", () => {
    const isKnown = (name: string) => name === "invite" || name === "help"

    it("renders a known command as a styled chip", () => {
      const result = renderMentions("/invite @alice", noEmoji, isKnown)
      render(<>{result}</>)

      expect(screen.getByText("/invite")).toBeInTheDocument()
    })

    it("leaves an unknown command as plain text", () => {
      const result = renderMentions("/s", noEmoji, isKnown)

      expect(result).toEqual(["/s"])
    })

    it("defaults to plain text when no predicate is provided", () => {
      const result = renderMentions("/invite foo", noEmoji)

      expect(result).toEqual(["/invite foo"])
    })

    it("does not treat a slash in the middle of a line as a command", () => {
      const result = renderMentions("see /help for more", noEmoji, isKnown)

      expect(result).toEqual(["see /help for more"])
    })
  })
})
