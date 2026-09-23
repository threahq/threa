import { memo, useMemo, type ReactNode } from "react"
import Markdown, { type Options } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeKatex from "rehype-katex"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize"
import "katex/dist/katex.min.css"
import { extractMath, normalizeMarkdownTables, parseMentionPointerHref } from "@threahq/prosemirror"
import { cn } from "@/lib/utils"
import { markdownComponents } from "@/lib/markdown/components"
import { remarkThreaMath } from "@/lib/markdown/remark-math"
import { remarkQuoteBreaks } from "@/lib/markdown/remark-quote-breaks"
import { rehypeLinkedImages } from "@/lib/markdown/rehype-linked-images"
import { KATEX_OPTIONS } from "@/lib/markdown/katex-options"
import { MentionProvider, type MentionType } from "@/lib/markdown/mention-context"
import { AttachmentProvider } from "@/lib/markdown/attachment-context"
import { MarkdownBlockProvider } from "@/lib/markdown/markdown-block-context"
import type { Mentionable } from "@/components/editor/triggers/types"

export { AttachmentProvider }

const remarkPlugins = [remarkGfm, remarkQuoteBreaks, remarkThreaMath]
const rehypePlugins: Options["rehypePlugins"] = [rehypeLinkedImages, [rehypeKatex, KATEX_OPTIONS]]

// GitHub's own sanitize rules (the default schema), plus the math markers
// rehype-katex reads. `<source>` goes because its srcset would load a remote
// image, which the img renderer deliberately never does. `<style>` goes with
// its text, which the default schema would otherwise leave behind as prose.
const htmlSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  strip: [...(defaultSchema.strip ?? []), "style"],
  tagNames: defaultSchema.tagNames?.filter((tag) => tag !== "source"),
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["className", "math", "math-inline", "math-display"]],
  },
}
const htmlRehypePlugins: Options["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, htmlSanitizeSchema],
  rehypeLinkedImages,
  [rehypeKatex, KATEX_OPTIONS],
]

interface MarkdownContentProps {
  content: string
  className?: string
  /**
   * When provided, collapsible markdown blocks (code blocks, blockquotes,
   * quote replies) persist their collapse state per message (keyed by
   * messageId + block kind + content hash) and honor the user's collapse
   * threshold preferences.
   */
  messageId?: string
  /**
   * Render embedded HTML, sanitized to GitHub's rules, instead of showing it as
   * text. For third-party markdown that leans on HTML (GitHub READMEs and
   * comments); anything a Threa user wrote keeps its HTML as text.
   */
  allowHtml?: boolean
}

/**
 * URL transformer that allows attachment: URLs to pass through.
 * By default, react-markdown strips unrecognized protocols.
 */
function urlTransform(url: string): string {
  // Allow attachment: protocol for inline file references
  if (url.startsWith("attachment:")) {
    return url
  }
  // Allow quote: protocol for quote-reply attribution links
  if (url.startsWith("quote:")) {
    return url
  }
  // Allow shared-message: protocol so the paragraph renderer can detect the
  // anchor and swap it for the pointer card. react-markdown strips unknown
  // protocols by default, which would hide the link metadata we rely on.
  if (url.startsWith("shared-message:")) {
    return url
  }
  // Allow memo: protocol so the paragraph renderer can detect the anchor and
  // swap it for the memo-embed card. Same reasoning as shared-message: above.
  if (url.startsWith("memo:")) {
    return url
  }
  // Allow agent: protocol so the blockquote renderer can detect the attribution
  // anchor and swap the quote for the agent block. Same reasoning as above.
  if (url.startsWith("agent:")) {
    return url
  }
  // Allow giphy: protocol so the link renderer can swap the anchor for the
  // inline GIF embed. Same reasoning as the pointer protocols above.
  if (url.startsWith("giphy:")) {
    return url
  }
  // Allow the mention/channel pointer schemes (user:/persona:/bot:/broadcast:/
  // channel:) so MarkdownLink can render them as chips (INV-64). Without this,
  // react-markdown blanks the unknown scheme and the chip degrades to bare text.
  if (parseMentionPointerHref(url)) {
    return url
  }
  // For other URLs, use default behavior (returns url as-is for http/https/mailto)
  const protocols = ["http:", "https:", "mailto:", "tel:"]
  const parsed = url.includes(":") ? url.split(":")[0] + ":" : ""
  if (protocols.includes(parsed) || url.startsWith("/") || url.startsWith("#")) {
    return url
  }
  return ""
}

/**
 * Basic markdown renderer without mention context.
 * Uses fallback mention styling (all mentions styled as users).
 */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
  messageId,
  allowHtml,
}: MarkdownContentProps) {
  // remark-gfm rejects tables with blank lines between rows, which LLM output
  // and some pasted markdown contain. Collapsing those blanks lets the table
  // render instead of falling through to plain paragraphs.
  //
  // Math is lifted out here, before parsing: a TeX body is not markdown, and
  // CommonMark would eat its escapes and split it on emphasis (`$x^*$ and $y^*$`).
  const normalizedContent = useMemo(() => extractMath(normalizeMarkdownTables(content)), [content])
  const body = (
    // min-w-0 + break-words: prevent long URLs, paths, and tokens from
    // overflowing the flex message-content column. overflow-wrap inherits,
    // so links, inline code, and mention chips pick it up automatically.
    <div className={cn("markdown-content min-w-0 break-words", className)}>
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={allowHtml ? htmlRehypePlugins : rehypePlugins}
        components={markdownComponents}
        urlTransform={urlTransform}
      >
        {normalizedContent}
      </Markdown>
    </div>
  )
  if (messageId) {
    return <MarkdownBlockProvider messageId={messageId}>{body}</MarkdownBlockProvider>
  }
  return body
})

interface MarkdownWithMentionsProps {
  content: string
  className?: string
  mentionables: Mentionable[]
}

/**
 * Markdown renderer with mention context for correct styling.
 * Wraps content with MentionProvider to enable "me" highlighting and proper mention types.
 */
export function MarkdownWithMentions({ content, className, mentionables }: MarkdownWithMentionsProps) {
  return (
    <MentionProvider mentionables={mentionables}>
      <MarkdownContent content={content} className={className} />
    </MentionProvider>
  )
}

export interface MentionableMarkdownWrapperProps {
  children: ReactNode
  mentionables: Mentionable[]
  onMentionClick?: (slug: string, type: MentionType, id?: string) => void
}

/**
 * Wrapper that provides mention context to its children.
 * Use this to wrap areas where messages are rendered to enable correct mention styling.
 */
export function MentionableMarkdownWrapper({
  children,
  mentionables,
  onMentionClick,
}: MentionableMarkdownWrapperProps) {
  return (
    <MentionProvider mentionables={mentionables} onMentionClick={onMentionClick}>
      {children}
    </MentionProvider>
  )
}
