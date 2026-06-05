import type { Components } from "react-markdown"
import { Children, isValidElement, type ReactNode, type MouseEvent } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { parseGiphyHref, parseMemoHref, parseQuoteHref, parseSharedMessageHref } from "@threa/prosemirror"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { MemoChip } from "@/components/memo-embed/memo-chip"
import { GifChip } from "@/components/giphy/gif-chip"
import { ProcessedChildren } from "./mention-renderer"
import { useAttachmentContext } from "./attachment-context"
import { useLinkPreviewContext } from "./link-preview-context"
import { QuoteReplyBlock } from "./quote-reply-block"
import { BlockquoteBlock } from "./blockquote-block"
import { SharedMessagePointerBlock } from "./shared-message-block"
import CodeBlock from "./code-block"

/**
 * Treat any link to our own origin as in-app navigation. Without this, a
 * markdown link like `https://app.threa.io/w/.../s/...?m=msg_xxx` rendered
 * inside the installed PWA on Android hops to a Custom Tab (browser chrome,
 * "open in Firefox") because `target="_blank"` forces a new browsing context.
 */
function resolveInternalAppPath(href: string): string | null {
  try {
    const url = new URL(href, window.location.origin)
    if (url.origin !== window.location.origin) return null
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

// The serializer emits these prefixes verbatim, no marks or extra text. Match
// the shape exactly so a mixed paragraph like "FYI Shared a message from
// [Alice](...)" doesn't get hijacked into a pointer block.
const SHARED_MESSAGE_PREFIX = "Shared a message from "
const QUOTE_ATTRIBUTION_PREFIX = "— "

/**
 * Resolve a `<p>` (or `<p>`-shaped node's children) that matches the exact
 * serializer-produced "prefix text + single anchor" pattern. Returns the
 * parsed href payload plus the anchor's plain-text content (the human-readable
 * author name) when matched, `null` otherwise.
 */
function matchAnchorParagraph<T>(
  children: ReactNode,
  expectedPrefix: string,
  parseHref: (href: string) => T | null
): (T & { linkText: string }) | null {
  const arr = Children.toArray(children)
  if (arr.length !== 2) return null
  const [prefix, anchor] = arr
  if (prefix !== expectedPrefix) return null
  if (!isValidElement(anchor)) return null
  const props = anchor.props as Record<string, unknown>
  if (typeof props.href !== "string") return null
  const parsed = parseHref(props.href)
  if (!parsed) return null
  return { ...parsed, linkText: extractTextFromChildren(props.children as ReactNode) }
}

/**
 * Detects whether a paragraph's children are *exactly* the serializer-produced
 * shared-message pointer line (prefix text + a `shared-message:` anchor and
 * nothing else). Mixed paragraphs that happen to contain such a link are
 * intentionally not matched — they'd lose their surrounding text.
 */
function findSharedMessageInChildren(
  children: ReactNode
): { streamId: string; messageId: string; authorName: string } | null {
  const match = matchAnchorParagraph(children, SHARED_MESSAGE_PREFIX, parseSharedMessageHref)
  if (!match) return null
  return { streamId: match.streamId, messageId: match.messageId, authorName: match.linkText }
}

/**
 * Walk a blockquote's children for the serializer's quote-reply attribution
 * paragraph: a `<p>` whose children are exactly "— " followed by a single
 * `quote:` anchor. Returns the parsed metadata plus the children that come
 * before that paragraph (the actual quoted content), or `null` if this is
 * a regular blockquote or the last paragraph isn't an exact attribution shape.
 */
function extractQuoteReplyFromChildren(children: ReactNode): {
  authorName: string
  streamId: string
  messageId: string
  authorId: string
  actorType: string
  quotedContent: ReactNode[]
} | null {
  const childArray: ReactNode[] = Children.toArray(children)

  for (let i = childArray.length - 1; i >= 0; i--) {
    const child = childArray[i]
    if (!isValidElement(child)) continue

    const props = child.props as Record<string, unknown>
    const match = matchAnchorParagraph(props.children as ReactNode, QUOTE_ATTRIBUTION_PREFIX, parseQuoteHref)
    if (match) {
      return {
        authorName: match.linkText,
        streamId: match.streamId,
        messageId: match.messageId,
        authorId: match.authorId,
        actorType: match.actorType,
        quotedContent: childArray.slice(0, i),
      }
    }
  }

  return null
}

/**
 * Extract plain text from React children tree.
 */
function extractTextFromChildren(children: ReactNode): string {
  if (typeof children === "string") return children
  if (typeof children === "number") return String(children)
  if (!children) return ""
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join("")
  if (isValidElement(children)) {
    const props = children.props as Record<string, unknown>
    return extractTextFromChildren(props.children as ReactNode)
  }
  return ""
}

/**
 * Link component that handles attachment:// URLs specially
 */
function MarkdownLink({ href, children }: { href?: string; children: ReactNode }) {
  const attachmentContext = useAttachmentContext()
  const linkPreviewContext = useLinkPreviewContext()
  const navigate = useNavigate()
  const { workspaceId } = useParams<{ workspaceId: string }>()

  // `memo:` reference — render the inline memo chip. The hydrated preview card
  // renders separately below the message (`MemoPreviewList`). The chip links to
  // the memo in the memory explorer.
  // `giphy:` reference — render the inline chip; the GIF preview surfaces below
  // the message (`GiphyPreviewList`), like memo cards and attachments.
  const giphyHref = href ? parseGiphyHref(href) : null
  if (giphyHref) {
    return <GifChip label={<ProcessedChildren>{children}</ProcessedChildren>} />
  }

  const memoHref = href ? parseMemoHref(href) : null
  if (memoHref) {
    const label = <MemoChip label={<ProcessedChildren>{children}</ProcessedChildren>} />
    // Outside a workspace route there's no memory explorer to link to — render
    // the chip without an anchor rather than an `href="#"` that jumps to top.
    if (!workspaceId) return label
    const target = `/w/${workspaceId}/memory?memo=${memoHref.memoId}`
    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      navigate(target)
    }
    return (
      <a href={target} onClick={handleClick} className="no-underline">
        {label}
      </a>
    )
  }

  // Check if this is an attachment link
  if (href?.startsWith("attachment:")) {
    const attachmentId = href.replace("attachment:", "")

    const handleClick = (e: MouseEvent) => {
      e.preventDefault()
      attachmentContext?.openAttachment(attachmentId, e.metaKey || e.ctrlKey)
    }

    const handleMouseEnter = () => {
      attachmentContext?.setHoveredAttachmentId(attachmentId)
    }

    const handleMouseLeave = () => {
      attachmentContext?.setHoveredAttachmentId(null)
    }

    return (
      <button
        type="button"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="break-all text-primary underline underline-offset-4 hover:text-primary/80 [&_span]:[text-decoration:inherit] cursor-pointer"
      >
        <ProcessedChildren>{children}</ProcessedChildren>
      </button>
    )
  }

  // Regular link — sync hover with link preview context
  const handleMouseEnter = () => {
    if (href) linkPreviewContext?.setHoveredLinkUrl(href)
  }

  const handleMouseLeave = () => {
    linkPreviewContext?.setHoveredLinkUrl(null)
  }

  const internalPath = href ? resolveInternalAppPath(href) : null
  if (internalPath) {
    // Modifier-clicks and middle-clicks fall through to the native <a> so the
    // user still gets "open in new tab" / right-click menu semantics.
    const handleInternalClick = (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented) return
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      navigate(internalPath)
    }
    return (
      <a
        href={href}
        onClick={handleInternalClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="break-all text-primary underline underline-offset-4 hover:text-primary/80 [&_span]:[text-decoration:inherit]"
      >
        <ProcessedChildren>{children}</ProcessedChildren>
      </a>
    )
  }

  // The message-level long-press hook skips its timer when the touch starts
  // inside an <a href> (via deferToNativeLinks: true), so long-press here gets
  // the native browser menu (e.g. "Open in Firefox", "Copy link") instead of
  // the message drawer.
  return (
    // break-all so long URLs wrap inside the message column instead of
    // forcing horizontal overflow (URLs rarely contain whitespace).
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="break-all text-primary underline underline-offset-4 hover:text-primary/80 [&_span]:[text-decoration:inherit]"
    >
      <ProcessedChildren>{children}</ProcessedChildren>
    </a>
  )
}

export const markdownComponents: Components = {
  // Headers - scaled for message context, process @mentions, #channels, and :emoji:
  h1: ({ children }) => (
    <h1 className="text-xl font-bold mt-4 mb-2 first:mt-0">
      <ProcessedChildren>{children}</ProcessedChildren>
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-lg font-bold mt-3 mb-2 first:mt-0">
      <ProcessedChildren>{children}</ProcessedChildren>
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold mt-3 mb-1 first:mt-0">
      <ProcessedChildren>{children}</ProcessedChildren>
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-sm font-semibold mt-2 mb-1 first:mt-0">
      <ProcessedChildren>{children}</ProcessedChildren>
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-sm font-medium mt-2 mb-1 first:mt-0">
      <ProcessedChildren>{children}</ProcessedChildren>
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-sm font-medium text-muted-foreground mt-2 mb-1 first:mt-0">
      <ProcessedChildren>{children}</ProcessedChildren>
    </h6>
  ),

  // Paragraphs - process @mentions, #channels, and :emoji:. If the paragraph
  // carries a shared-message: anchor, swap the whole paragraph for the pointer
  // card (the serializer emits a single-line paragraph for each share, so
  // this lossless swap is always correct).
  p: ({ children }) => {
    const share = findSharedMessageInChildren(children)
    if (share) {
      return (
        <SharedMessagePointerBlock
          streamId={share.streamId}
          messageId={share.messageId}
          authorName={share.authorName}
        />
      )
    }
    return (
      <p className="mb-2 last:mb-0">
        <ProcessedChildren>{children}</ProcessedChildren>
      </p>
    )
  },

  // Links - handles both regular links and attachment:// URLs
  // [&_span] ensures inline-flex elements like TriggerChips inherit underline decoration
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,

  // Code - inline and blocks
  code: ({ className, children }) => {
    const isCodeBlock = className?.includes("language-")

    if (isCodeBlock) {
      const language = className?.replace("language-", "") || "text"
      return <CodeBlock language={language}>{String(children)}</CodeBlock>
    }

    // Inline code — break-all so long identifiers, paths, or tokens inside
    // backticks wrap inside the message column instead of overflowing.
    return <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono break-all">{children}</code>
  },

  // Code blocks wrapper - let code component handle rendering
  pre: ({ children }) => <>{children}</>,

  // Bold
  strong: ({ children }) => (
    <strong className="font-semibold">
      <ProcessedChildren>{children}</ProcessedChildren>
    </strong>
  ),

  // Italic
  em: ({ children }) => (
    <em className="italic">
      <ProcessedChildren>{children}</ProcessedChildren>
    </em>
  ),

  // Strikethrough (GFM) - [&_span] ensures inline-flex elements like TriggerChips inherit decoration
  del: ({ children }) => (
    <del className="line-through text-muted-foreground [&_span]:[text-decoration:inherit]">
      <ProcessedChildren>{children}</ProcessedChildren>
    </del>
  ),

  // Blockquote — detect quote-reply attribution pattern (quote: protocol link)
  blockquote: ({ children }) => {
    const quoteReply = extractQuoteReplyFromChildren(children)
    if (quoteReply) {
      return (
        <QuoteReplyBlock
          authorName={quoteReply.authorName}
          authorId={quoteReply.authorId}
          actorType={quoteReply.actorType}
          streamId={quoteReply.streamId}
          messageId={quoteReply.messageId}
        >
          {quoteReply.quotedContent}
        </QuoteReplyBlock>
      )
    }
    return <BlockquoteBlock>{children}</BlockquoteBlock>
  },

  // Lists
  ul: ({ children }) => <ul className="list-disc pl-6 my-2">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-6 my-2">{children}</ol>,
  li: ({ children, className }) => {
    const isTaskItem = className?.includes("task-list-item")
    return (
      <li className={cn("mb-1", isTaskItem && "list-none -ml-6")}>
        <ProcessedChildren>{children}</ProcessedChildren>
      </li>
    )
  },

  // Task list checkboxes (read-only)
  input: ({ type, checked }) => {
    if (type === "checkbox") {
      return <Checkbox checked={checked} disabled className="mr-2 align-middle cursor-default" />
    }
    return null
  },

  // Tables - use Shadcn UI Table
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <Table>{children}</Table>
    </div>
  ),
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => (
    <TableHead>
      <ProcessedChildren>{children}</ProcessedChildren>
    </TableHead>
  ),
  td: ({ children }) => (
    <TableCell>
      <ProcessedChildren>{children}</ProcessedChildren>
    </TableCell>
  ),

  // Horizontal rule
  hr: () => <hr className="my-4 border-border" />,

  // Images - render as links (no embedding for external URLs)
  img: ({ src, alt }) => (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-primary underline underline-offset-4 hover:text-primary/80"
    >
      {alt || src}
    </a>
  ),
}
