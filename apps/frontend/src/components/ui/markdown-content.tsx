import { memo, useMemo, type ReactNode } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { normalizeMarkdownTables } from "@threa/prosemirror"
import { cn } from "@/lib/utils"
import { markdownComponents } from "@/lib/markdown/components"
import { MentionProvider, type MentionType } from "@/lib/markdown/mention-context"
import { AttachmentProvider } from "@/lib/markdown/attachment-context"
import { MarkdownBlockProvider } from "@/lib/markdown/markdown-block-context"
import type { Mentionable } from "@/components/editor/triggers/types"

export { AttachmentProvider }

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
  // Allow giphy: protocol so the link renderer can swap the anchor for the
  // inline GIF embed. Same reasoning as the pointer protocols above.
  if (url.startsWith("giphy:")) {
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
export const MarkdownContent = memo(function MarkdownContent({ content, className, messageId }: MarkdownContentProps) {
  // remark-gfm rejects tables with blank lines between rows, which LLM output
  // and some pasted markdown contain. Collapsing those blanks lets the table
  // render instead of falling through to plain paragraphs.
  const normalizedContent = useMemo(() => normalizeMarkdownTables(content), [content])
  const body = (
    // min-w-0 + break-words: prevent long URLs, paths, and tokens from
    // overflowing the flex message-content column. overflow-wrap inherits,
    // so links, inline code, and mention chips pick it up automatically.
    <div className={cn("markdown-content min-w-0 break-words", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={urlTransform}>
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
  onMentionClick?: (slug: string, type: MentionType) => void
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
