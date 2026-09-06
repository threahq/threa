import type { ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { MarkdownContent, AttachmentProvider } from "@/components/ui/markdown-content"
import { AttachmentList } from "@/components/timeline/attachment-list"
import { type SharedMessageSource } from "@/hooks/use-shared-message-source"
import { streamFallbackLabel } from "@/lib/streams"
import type { StreamType, Visibility } from "@threahq/types"

/**
 * Body renderer shared between the two pointer-card surfaces:
 *
 *   - `SharedMessageView` — TipTap NodeView mounted inside the composer.
 *   - `SharedMessagePointerBlock` — paragraph swap inside the markdown
 *     renderer, used in the timeline / thread panel / activity feed.
 *
 * Both surfaces want the same byline + body for each `SharedMessageSource`
 * status, with the same fallback-author + author-label semantics. Keeping
 * the rendering in one place avoids the two surfaces drifting apart on
 * styling changes.
 *
 * `fallbackAuthor` is the pre-hydration label: the NodeView passes
 * `attrs.authorName` (stamped on the node at share time), the markdown
 * block passes the link-text the markdown serializer emitted.
 *
 * `sourceHref` is the source message's permalink, and it is optional because
 * one of the two surfaces already IS that link: the markdown block wraps the
 * whole card in it, so an "Edited since" anchor there would nest one `<a>`
 * inside another. That surface passes nothing and the marker renders as text
 * the card's own link already carries.
 */
export function SharedMessageCardBody({
  source,
  fallbackAuthor,
  sourceHref,
}: {
  source: SharedMessageSource
  fallbackAuthor: string
  sourceHref?: string
}) {
  // The ok-branch needs `workspaceId` to render `<AttachmentList>` (it
  // resolves presigned URLs via the workspace-scoped attachment API).
  // Both call sites — `SharedMessageView` (TipTap NodeView) and
  // `SharedMessagePointerBlock` (markdown renderer) — mount under the
  // `/w/:workspaceId` route, so this is always defined at runtime.
  const { workspaceId } = useParams<{ workspaceId: string }>()

  if (source.status === "deleted") {
    return (
      <>
        <AuthorLabel name={fallbackAuthor || "—"} />
        <p className="mt-0.5 italic text-muted-foreground">Message deleted by author</p>
      </>
    )
  }

  if (source.status === "missing") {
    return (
      <>
        <AuthorLabel name={fallbackAuthor || "—"} />
        <p className="mt-0.5 italic text-muted-foreground">Message no longer available</p>
      </>
    )
  }

  if (source.status === "private") {
    return <PrivatePlaceholder kind={source.sourceStreamKind} visibility={source.sourceVisibility} />
  }

  if (source.status === "truncated") {
    return <TruncatedPlaceholder streamId={source.streamId} messageId={source.messageId} />
  }

  if (source.status === "pending") {
    return (
      <>
        <AuthorLabel name={fallbackAuthor || "—"} />
        {source.showSkeleton ? (
          <Skeleton className="mt-1 h-3 w-48" />
        ) : (
          // Before the staggered-skeleton threshold, leave the body blank so
          // the common fast-path (content resolves within 300ms) doesn't flash
          // a loading state. The row still shows the author for layout
          // stability.
          <p className="mt-0.5 h-3" aria-hidden="true" />
        )}
      </>
    )
  }

  // A ranged share is a span of text the sharer picked, not the message's
  // files — the server sends none, and a cached fallback must not add any.
  const attachments = source.range ? [] : (source.attachments ?? [])
  const editedSince =
    source.version != null && source.currentRevision != null && source.currentRevision > source.version
  // Only mount `<AttachmentProvider>` when there's something to render —
  // it depends on `MediaGalleryContext`, which the shared-message card's
  // call sites (TipTap NodeView, markdown-block) wrap in but isolated
  // tests don't necessarily provide. Cards without attachments stay a
  // pure markdown render, matching the Slice 1/2 behavior.
  const hasAttachments = workspaceId !== undefined && attachments.length > 0
  const body = (
    <div className="mt-0.5">
      {/* The card is the live inline rendering of the source message, not a
          single-line preview, so it gets full markdown (emoji, mentions,
          formatting) rather than the strip-to-inline used by sidebar
          surfaces. INV-60 doesn't apply here. */}
      <MarkdownContent content={source.contentMarkdown} className="text-sm leading-relaxed" />
    </div>
  )
  return (
    <>
      <AuthorLabel
        name={source.authorName || fallbackAuthor || "—"}
        trailing={editedSince ? <EditedSinceMarker href={sourceHref} /> : null}
      />
      {hasAttachments ? (
        <AttachmentProvider workspaceId={workspaceId} attachments={attachments}>
          {body}
          <AttachmentList attachments={attachments} workspaceId={workspaceId} />
        </AttachmentProvider>
      ) : (
        body
      )}
    </>
  )
}

function AuthorLabel({ name, trailing }: { name: string; trailing?: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="min-w-0 truncate text-xs font-medium text-foreground/80">{name}</span>
      {trailing}
    </span>
  )
}

/**
 * The source has been edited since this share was pinned, so the card is
 * showing an older revision on purpose. Negative margins keep the 24px tap
 * target from growing the byline's line box, so the marker appearing never
 * moves anything below it (INV-21).
 */
function EditedSinceMarker({ href }: { href?: string }) {
  const className = "-my-1 shrink-0 rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground"
  if (!href) return <span className={className}>Edited since</span>
  return (
    <Link to={href} className={cn(className, "underline underline-offset-2 hover:text-foreground")}>
      Edited since
    </Link>
  )
}

/**
 * Privacy-preserving placeholder shown when the viewer hit an inner pointer
 * in a re-share chain that they have no read path to. Reveals only the
 * source stream's kind + visibility — never content, author, or stream
 * name (minimizes the leak surface that a downstream re-share could
 * otherwise expose).
 */
function PrivatePlaceholder({ kind, visibility }: { kind: StreamType; visibility: Visibility }) {
  return (
    <>
      <AuthorLabel name="Private message" />
      <p className="mt-0.5 italic text-muted-foreground">
        This message references content in a {visibility} {streamFallbackLabel(kind, "noun")} you don't have access to.
      </p>
    </>
  )
}

/**
 * Placeholder for pointers past the recursive-hydration depth cap. The
 * viewer has access (the chain only truncates on accessible paths), so
 * the body is a navigation link rather than a privacy stub.
 */
function TruncatedPlaceholder({ streamId, messageId }: { streamId: string; messageId: string }) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const href = workspaceId ? `/w/${workspaceId}/s/${streamId}?m=${messageId}` : `#`
  return (
    <>
      <AuthorLabel name="Nested share" />
      <p className="mt-0.5 italic text-muted-foreground">
        This message references a deeper share —{" "}
        <Link to={href} className="underline underline-offset-2 hover:text-foreground">
          open in source stream
        </Link>
        .
      </p>
    </>
  )
}
