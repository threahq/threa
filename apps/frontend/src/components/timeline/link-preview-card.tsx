import { useState, useCallback, useEffect, useMemo, type ReactNode } from "react"
import {
  ExternalLink,
  X,
  FileText,
  Image as ImageIcon,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  GitMerge,
  CircleDot,
  CircleCheck,
  GitCommitHorizontal,
  MessageSquare,
  FileCode,
  Folder,
  File,
  Play,
  Video as VideoIcon,
  Maximize2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { cn } from "@/lib/utils"
import { MediaGallery, type GalleryItem } from "@/components/image-gallery"
import { linkPreviewGalleryId } from "@/components/gallery/link-preview-gallery-id"
import { isVideoPreview, videoPlaybackSrc } from "@/components/gallery/video-embed"
import { LinkPreviewBody } from "./link-preview-body"
import { AccentGlow, colorWithAlpha, Field, FieldGrid, LabelChip, MonoTag, StatePill } from "./link-preview-primitives"
import type {
  GitHubFilePreviewData,
  GitHubPrPreviewData,
  GitHubIssuePreviewData,
  GitHubCommitPreviewData,
  GitHubCommentPreviewData,
  GitHubDiffPreviewData,
  GitHubPreview,
  GitHubPreviewActor,
  LinearActor,
  LinearCommentPreviewData,
  LinearDocumentPreviewData,
  LinearIssuePreviewData,
  LinearPreview,
  LinearProjectPreviewData,
  LinkPreviewSummary,
  VideoPreview,
} from "@threa/types"

function isLinearPreview(
  preview: GitHubPreview | LinearPreview | VideoPreview | null | undefined
): preview is LinearPreview {
  return !!preview && typeof preview.type === "string" && preview.type.startsWith("linear_")
}

interface LinkPreviewCardProps {
  preview: LinkPreviewSummary
  /**
   * Scopes the per-preview "Show more" persistence key. Optional so tests and
   * transient previews without a host message still render.
   */
  messageId?: string
  /**
   * Workspace scope for the image gallery. Unused for external link-preview
   * images (their download/copy are gated off), so optional for tests.
   */
  workspaceId?: string
  isHighlighted?: boolean
  isCollapsed?: boolean
  onDismiss?: (previewId: string) => void
  onToggleCollapse?: (previewId: string) => void
}

function ContentTypeIcon({ contentType }: { contentType: string }) {
  switch (contentType) {
    case "pdf":
      return <FileText className="h-4 w-4 text-red-500 shrink-0" />
    case "image":
      return <ImageIcon className="h-4 w-4 text-blue-500 shrink-0" />
    case "video":
      return <VideoIcon className="h-4 w-4 text-rose-500 shrink-0" />
    default:
      return <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
  }
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function resolveHeaderIcon(
  githubPreview: GitHubPreview | null,
  linearPreview: LinearPreview | null,
  contentType: string
) {
  if (githubPreview) return <GitHubTypeIcon type={githubPreview.type} data={githubPreview.data} />
  if (linearPreview) return <LinearTypeIcon type={linearPreview.type} />
  return <ContentTypeIcon contentType={contentType} />
}

function resolveHeaderLabel(
  githubPreview: GitHubPreview | null,
  linearPreview: LinearPreview | null,
  siteName: string | null,
  domain: string
): string {
  if (githubPreview) return githubPreview.repository.fullName
  if (linearPreview) return `${linearPreview.organization.name} · Linear`
  return siteName ?? domain
}

export function LinkPreviewCard({
  preview,
  messageId,
  workspaceId,
  isHighlighted,
  isCollapsed: isCollapsedProp,
  onDismiss,
  onToggleCollapse,
}: LinkPreviewCardProps) {
  const [imageError, setImageError] = useState(false)
  const domain = getDomain(preview.url)
  const providerPreview = preview.previewData
  const videoPreview = isVideoPreview(providerPreview) ? providerPreview : null
  const githubPreview =
    providerPreview && !isLinearPreview(providerPreview) && !isVideoPreview(providerPreview) ? providerPreview : null
  const linearPreview = isLinearPreview(providerPreview) ? providerPreview : null

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onDismiss?.(preview.id)
    },
    [onDismiss, preview.id]
  )

  const handleToggleCollapse = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onToggleCollapse?.(preview.id)
    },
    [onToggleCollapse, preview.id]
  )

  if (preview.contentType === "image") {
    // data-native-context makes the row long-press hook defer to the browser's
    // native menu (via `deferToNativeLinks`), so long-pressing the image still
    // gets "save/copy image" on touch instead of the app drawer — the tap opens
    // the gallery, and the gallery gates download/copy off for external images.
    return (
      <div
        data-native-context="true"
        className={cn(
          "group/preview reveal-host relative overflow-hidden rounded-lg border bg-card transition-all max-w-md",
          "hover:border-primary/50 hover:shadow-sm",
          isHighlighted && "ring-2 ring-primary border-primary shadow-sm"
        )}
      >
        <PreviewCardHeader
          icon={<ContentTypeIcon contentType="image" />}
          label={preview.siteName ?? domain}
          faviconUrl={preview.faviconUrl}
          isCollapsed={isCollapsedProp}
          onToggleCollapse={handleToggleCollapse}
          onDismiss={onDismiss ? handleDismiss : undefined}
        />
        {!isCollapsedProp && <ImagePreviewContent preview={preview} workspaceId={workspaceId} />}
      </div>
    )
  }

  if (preview.contentType === "video" && videoPreview) {
    return (
      <div
        data-native-context="true"
        className={cn(
          "group/preview reveal-host relative overflow-hidden rounded-lg border bg-card transition-all max-w-md",
          "hover:border-primary/50 hover:shadow-sm",
          isHighlighted && "ring-2 ring-primary border-primary shadow-sm"
        )}
      >
        <PreviewCardHeader
          icon={<ContentTypeIcon contentType="video" />}
          label={preview.siteName ?? domain}
          faviconUrl={preview.faviconUrl}
          isCollapsed={isCollapsedProp}
          onToggleCollapse={handleToggleCollapse}
          onDismiss={onDismiss ? handleDismiss : undefined}
        />
        {!isCollapsedProp && <VideoPreviewContent video={videoPreview} workspaceId={workspaceId} />}
      </div>
    )
  }

  const headerIcon = resolveHeaderIcon(githubPreview, linearPreview, preview.contentType)
  const headerLabel = resolveHeaderLabel(githubPreview, linearPreview, preview.siteName, domain)

  // data-native-context tells the message-level long-press hook to skip its
  // timer so long-pressing anywhere on the card gets the browser's native link
  // menu (via the inner <a>) instead of the message drawer.
  return (
    <div
      data-native-context="true"
      className={cn(
        "group/preview reveal-host relative overflow-hidden rounded-lg border bg-card transition-all max-w-md",
        "hover:border-primary/50 hover:shadow-sm",
        isHighlighted && "ring-2 ring-primary border-primary shadow-sm"
      )}
    >
      <PreviewCardHeader
        icon={headerIcon}
        label={headerLabel}
        faviconUrl={!githubPreview && !linearPreview ? preview.faviconUrl : null}
        isCollapsed={isCollapsedProp}
        onToggleCollapse={handleToggleCollapse}
        onDismiss={onDismiss ? handleDismiss : undefined}
      />

      {/* Clamped to a shared body height so a message with mixed preview types
          (e.g. a PR + a diff) lines up. */}
      {!isCollapsedProp && (
        <LinkPreviewBody messageId={messageId} previewId={preview.id}>
          <a
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block hover:bg-muted/20 transition-colors"
          >
            <ProviderContent preview={preview} imageError={imageError} onImageError={() => setImageError(true)} />
          </a>
        </LinkPreviewBody>
      )}
    </div>
  )
}

/**
 * Card chrome header shared by every preview family: collapse toggle, provider
 * icon, optional favicon, source label, and dismiss. `faviconUrl` is null when
 * the provider already carries its own icon (GitHub/Linear).
 */
function PreviewCardHeader({
  icon,
  label,
  faviconUrl,
  isCollapsed,
  onToggleCollapse,
  onDismiss,
}: {
  icon: ReactNode
  label: string
  faviconUrl: string | null
  isCollapsed?: boolean
  onToggleCollapse: (e: React.MouseEvent) => void
  onDismiss?: (e: React.MouseEvent) => void
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b bg-muted/30">
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        aria-label={isCollapsed ? "Expand preview" : "Collapse preview"}
      >
        {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {icon}
      {faviconUrl && (
        <img
          src={faviconUrl}
          alt=""
          className="h-3.5 w-3.5 rounded-sm"
          loading="lazy"
          onError={(e) => {
            ;(e.target as HTMLImageElement).style.display = "none"
          }}
        />
      )}
      <span className="text-xs text-muted-foreground truncate">{label}</span>
      <ExternalLink className="h-3 w-3 text-muted-foreground/50 shrink-0 ml-auto" />
      <div className="reveal-actions flex gap-1">
        {onDismiss && (
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onDismiss} aria-label="Dismiss preview">
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  )
}

// Below this width/height (px) an og:image is a logo/icon rather than a hero
// shot: filling the box would upscale and crop it, so switch to a contained,
// centered fit. The box height is fixed either way, so this never reflows the
// timeline (INV-21) — only object-fit changes.
const HERO_MIN_WIDTH = 400
const HERO_MIN_HEIGHT = 200

/**
 * Image link preview: fixed-height hero inside the shared card chrome. Clicking
 * opens the full media gallery (zoom/pan) rather than leaving the app — the
 * image rides the gallery via a `link-preview:` sentinel id, so its bytes never
 * touch the attachment API (download/copy are gated off there).
 */
function ImagePreviewContent({ preview, workspaceId }: { preview: LinkPreviewSummary; workspaceId?: string }) {
  const [imageError, setImageError] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [fit, setFit] = useState<"cover" | "contain">("cover")

  const src = preview.imageUrl ?? preview.url
  const filename = preview.title ?? getDomain(preview.url)

  // A link preview is PATCHed in place as its metadata resolves (a real
  // `imageUrl` can replace the raw url on the same mounted card), so a stale
  // error or a `contain` fit measured off the previous image must not carry
  // over to the new one.
  useEffect(() => {
    setImageError(false)
    setFit("cover")
  }, [src])

  const galleryItems = useMemo<GalleryItem[]>(
    () => [{ type: "image", url: src, thumbnailUrl: src, filename, attachmentId: linkPreviewGalleryId(src) }],
    [src, filename]
  )

  return (
    <>
      <button
        type="button"
        onClick={() => setGalleryOpen(true)}
        className="relative block w-full cursor-zoom-in overflow-hidden"
        aria-label={`Open image preview${preview.title ? `: ${preview.title}` : ""}`}
      >
        <AccentGlow />
        {!imageError ? (
          <div className="relative flex h-48 w-full items-center justify-center overflow-hidden bg-muted/30">
            <img
              src={src}
              alt={preview.title ?? "Image preview"}
              loading="lazy"
              onLoad={(e) => {
                const img = e.currentTarget
                if (img.naturalWidth < HERO_MIN_WIDTH || img.naturalHeight < HERO_MIN_HEIGHT) setFit("contain")
              }}
              onError={() => setImageError(true)}
              className={cn(
                "transition-transform duration-200 group-hover/preview:scale-[1.02]",
                fit === "cover" ? "h-full w-full object-cover" : "max-h-full max-w-full object-contain"
              )}
            />
          </div>
        ) : (
          <div className="flex h-48 w-full items-center justify-center bg-muted/30 text-muted-foreground">
            <ImageIcon className="h-8 w-8" />
          </div>
        )}
      </button>
      {galleryOpen && (
        <MediaGallery
          isOpen={galleryOpen}
          onClose={() => setGalleryOpen(false)}
          items={galleryItems}
          initialIndex={0}
          workspaceId={workspaceId ?? ""}
        />
      )}
    </>
  )
}

/**
 * Video link preview: a click-to-play facade. The poster + play button occupy a
 * fixed-aspect box (reserved up front so neither the poster nor the iframe swap
 * reflows the timeline — INV-21). The third-party iframe only mounts after an
 * explicit click, so no external JS/cookies load until the user opts in. A
 * separate expand control opens the same embed fullscreen in the media gallery.
 */
function VideoPreviewContent({ video, workspaceId }: { video: VideoPreview; workspaceId?: string }) {
  const [playing, setPlaying] = useState(false)
  const [posterError, setPosterError] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)

  // Previews are PATCHed in place as metadata resolves; if the embed target
  // changes on the same mounted card, drop any in-progress playback/error state.
  useEffect(() => {
    setPlaying(false)
    setPosterError(false)
  }, [video.embedUrl])

  const title = video.title ?? getDomain(video.url)
  const aspectRatio = video.aspectRatio > 0 ? video.aspectRatio : 16 / 9

  const galleryItems = useMemo<GalleryItem[]>(
    () => [
      {
        type: "video-embed",
        url: video.url,
        embedUrl: video.embedUrl,
        provider: video.provider,
        posterUrl: video.posterUrl,
        aspectRatio,
        filename: title,
        attachmentId: linkPreviewGalleryId(video.embedUrl),
      },
    ],
    [video.url, video.embedUrl, video.provider, video.posterUrl, aspectRatio, title]
  )

  return (
    <>
      <div className="relative w-full overflow-hidden bg-black" style={{ aspectRatio }}>
        <AccentGlow />
        {playing ? (
          <iframe
            src={videoPlaybackSrc(video)}
            title={title}
            className="absolute inset-0 h-full w-full"
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <>
            <button
              type="button"
              onClick={() => setPlaying(true)}
              className="group/play absolute inset-0 flex cursor-pointer items-center justify-center"
              aria-label={`Play video: ${title}`}
            >
              {video.posterUrl && !posterError ? (
                <img
                  src={video.posterUrl}
                  alt=""
                  loading="lazy"
                  onError={() => setPosterError(true)}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-muted to-muted/40" />
              )}
              <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-black/60 text-white shadow-lg backdrop-blur-sm transition-transform group-hover/play:scale-110">
                <Play className="h-7 w-7 translate-x-0.5" fill="currentColor" />
              </span>
            </button>
            {video.title && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2.5">
                <span className="line-clamp-1 text-xs font-medium text-white">{video.title}</span>
              </div>
            )}
          </>
        )}
        {/* Expand-to-gallery stays mounted in both the facade and playing states
            (z-10 above the iframe) so fullscreen is reachable after playback
            starts. Anchored top-LEFT: every provider's interactive chrome
            (share/logo/fullscreen) lives top-right or along the bottom, so the
            left corner avoids colliding with the player's own controls. */}
        <button
          type="button"
          onClick={() => {
            // The gallery mounts its own playing embed; stop the facade's iframe
            // so the same video doesn't autoplay twice behind the overlay.
            setPlaying(false)
            setGalleryOpen(true)
          }}
          title="Open in gallery"
          className="absolute left-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white shadow-md backdrop-blur-sm transition-colors hover:bg-black/75"
          aria-label="Open video in fullscreen gallery"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
      {galleryOpen && (
        <MediaGallery
          isOpen={galleryOpen}
          onClose={() => setGalleryOpen(false)}
          items={galleryItems}
          initialIndex={0}
          workspaceId={workspaceId ?? ""}
        />
      )}
    </>
  )
}

function ProviderContent({
  preview,
  imageError,
  onImageError,
}: {
  preview: LinkPreviewSummary
  imageError: boolean
  onImageError: () => void
}) {
  const providerPreview = preview.previewData
  if (isLinearPreview(providerPreview)) {
    return <LinearContent preview={providerPreview} />
  }
  return <GitHubContent preview={preview} imageError={imageError} onImageError={onImageError} />
}

function GitHubTypeIcon({ type, data }: { type: string; data: GitHubPreview["data"] }) {
  switch (type) {
    case "github_pr": {
      const pr = data as GitHubPrPreviewData
      if (pr.state === "merged") return <GitMerge className="h-3.5 w-3.5 text-purple-500 shrink-0" />
      if (pr.state === "closed") return <GitPullRequest className="h-3.5 w-3.5 text-red-500 shrink-0" />
      return <GitPullRequest className="h-3.5 w-3.5 text-green-500 shrink-0" />
    }
    case "github_issue": {
      const issue = data as GitHubIssuePreviewData
      if (issue.state === "closed") return <CircleCheck className="h-3.5 w-3.5 text-purple-500 shrink-0" />
      return <CircleDot className="h-3.5 w-3.5 text-green-500 shrink-0" />
    }
    case "github_commit":
      return <GitCommitHorizontal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    case "github_file":
      return <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    case "github_diff":
      return <GitPullRequest className="h-3.5 w-3.5 text-green-500 shrink-0" />
    case "github_comment":
      return <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    default:
      return <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
  }
}

function GitHubContent({
  preview,
  imageError,
  onImageError,
}: {
  preview: LinkPreviewSummary
  imageError: boolean
  onImageError: () => void
}) {
  const ghPreview = preview.previewData
  if (!ghPreview) {
    return <GenericPreviewContent preview={preview} imageError={imageError} onImageError={onImageError} />
  }

  switch (ghPreview.type) {
    case "github_pr":
      return <GitHubPrContent data={ghPreview.data as GitHubPrPreviewData} />
    case "github_issue":
      return <GitHubIssueContent data={ghPreview.data as GitHubIssuePreviewData} />
    case "github_commit":
      return <GitHubCommitContent data={ghPreview.data as GitHubCommitPreviewData} />
    case "github_file":
      return <GitHubFileContent preview={preview} data={ghPreview.data as GitHubFilePreviewData} />
    case "github_diff":
      return <GitHubDiffContent data={ghPreview.data as GitHubDiffPreviewData} />
    case "github_comment":
      return <GitHubCommentContent data={ghPreview.data as GitHubCommentPreviewData} />
    default:
      return <GenericPreviewContent preview={preview} imageError={imageError} onImageError={onImageError} />
  }
}

function GenericPreviewContent({
  preview,
  imageError,
  onImageError,
}: {
  preview: LinkPreviewSummary
  imageError: boolean
  onImageError: () => void
}) {
  const fallbackLabel = getGenericFallbackLabel(preview.url)
  const hasPrimaryMetadata = Boolean(preview.title || preview.description || preview.imageUrl)
  const showImage = Boolean(preview.imageUrl) && !imageError

  // Text intentionally flows at natural height — `LinkPreviewBody` clips the
  // whole card to a shared ceiling and reveals a "Show more" toggle when
  // overflow occurs. Pre-truncating with `line-clamp-*` hid overflow from
  // `scrollHeight`, which suppressed the toggle and left blank space below.
  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow />
      <div className="relative flex gap-3.5">
        <div className="min-w-0 flex-1">
          {preview.title && <h4 className="text-sm font-semibold leading-snug text-foreground">{preview.title}</h4>}
          {preview.description && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{preview.description}</p>
          )}
          {!hasPrimaryMetadata && (
            <p className="text-xs text-muted-foreground">
              Open link: <span className="font-medium text-foreground">{fallbackLabel}</span>
            </p>
          )}
        </div>
        {showImage && (
          // Fixed footprint so the lazy image swapping in doesn't reflow the card (INV-21).
          <div className="h-[4.5rem] w-28 shrink-0 overflow-hidden rounded-md border bg-muted/40 shadow-sm">
            <img
              src={preview.imageUrl!}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              onError={onImageError}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function getGenericFallbackLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`
  } catch {
    return url
  }
}

// GitHub state hues mirror github.com: green (open), purple (merged / done), red
// (closed). One source drives both the state pill and the card's accent glow.
const GITHUB_OPEN_COLOR = "#22c55e"
const GITHUB_DONE_COLOR = "#a855f7"
const GITHUB_CLOSED_COLOR = "#ef4444"

const PR_STATE_LABELS = { merged: "Merged", closed: "Closed", open: "Open" } as const

function prStateColor(state: GitHubPrPreviewData["state"]): string {
  if (state === "merged") return GITHUB_DONE_COLOR
  if (state === "closed") return GITHUB_CLOSED_COLOR
  return GITHUB_OPEN_COLOR
}

function GitHubPrContent({ data }: { data: GitHubPrPreviewData }) {
  const stateColor = prStateColor(data.state)

  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow color={stateColor} />
      <div className="relative flex items-start gap-2.5">
        <ActorAvatar actor={data.author} className="mt-0.5 ring-2 ring-background" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatePill color={stateColor} dot>
              {PR_STATE_LABELS[data.state]}
            </StatePill>
            <MonoTag>#{data.number}</MonoTag>
          </div>
          <h4 className="mt-1.5 text-sm font-semibold leading-snug text-foreground line-clamp-2">{data.title}</h4>
          <FieldGrid className="mt-3">
            <Field label="Branch">
              <span title={`${data.headBranch} → ${data.baseBranch}`}>
                {data.headBranch}
                <span className="mx-0.5 text-muted-foreground">{"→"}</span>
                {data.baseBranch}
              </span>
            </Field>
            <Field label="Changes">
              <DiffStats additions={data.additions} deletions={data.deletions} />
            </Field>
            {data.author && <Field label="Author">@{data.author.login}</Field>}
          </FieldGrid>
          <ReviewSummary summary={data.reviewStatusSummary} />
        </div>
      </div>
    </div>
  )
}

function ReviewSummary({ summary }: { summary: GitHubPrPreviewData["reviewStatusSummary"] }) {
  const parts: string[] = []
  if (summary.approvals > 0) parts.push(`${summary.approvals} approved`)
  if (summary.changesRequested > 0) parts.push(`${summary.changesRequested} changes requested`)
  if (summary.pendingReviewers > 0) parts.push(`${summary.pendingReviewers} pending`)
  if (parts.length === 0) return null

  return <p className="mt-2.5 text-[11px] text-muted-foreground">{parts.join(" · ")}</p>
}

function GitHubIssueContent({ data }: { data: GitHubIssuePreviewData }) {
  const stateColor = data.state === "open" ? GITHUB_OPEN_COLOR : GITHUB_DONE_COLOR

  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow color={stateColor} />
      <div className="relative flex items-start gap-2.5">
        <ActorAvatar actor={data.author} className="mt-0.5 ring-2 ring-background" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatePill color={stateColor} dot>
              {data.state === "open" ? "Open" : "Closed"}
            </StatePill>
            <MonoTag>#{data.number}</MonoTag>
            {data.commentCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                <MessageSquare className="h-3 w-3" />
                {data.commentCount}
              </span>
            )}
          </div>
          <h4 className="mt-1.5 text-sm font-semibold leading-snug text-foreground line-clamp-2">{data.title}</h4>
          {data.labels.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {data.labels.slice(0, 5).map((label) => (
                <LabelChip key={label.name} color={label.color}>
                  {label.name}
                </LabelChip>
              ))}
              {data.labels.length > 5 && (
                <span className="self-center text-[11px] text-muted-foreground">+{data.labels.length - 5}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function GitHubCommitContent({ data }: { data: GitHubCommitPreviewData }) {
  const firstLine = data.message.split("\n")[0]

  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow />
      <div className="relative flex items-start gap-2.5">
        <ActorAvatar actor={data.author} className="mt-0.5 ring-2 ring-background" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <MonoTag>{data.shortSha}</MonoTag>
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">Commit</span>
          </div>
          <h4 className="mt-1.5 text-sm font-semibold leading-snug text-foreground line-clamp-2">{firstLine}</h4>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              {data.filesChanged} file{data.filesChanged !== 1 ? "s" : ""}
            </span>
            <DiffStats additions={data.additions} deletions={data.deletions} />
          </div>
        </div>
      </div>
    </div>
  )
}

function GitHubFileContent({ preview, data }: { preview: LinkPreviewSummary; data: GitHubFilePreviewData }) {
  let content = null

  if (data.renderMode === "markdown" && data.markdownContent) {
    content = (
      <div className="mt-2 overflow-hidden rounded-md border bg-muted/20 px-2.5 py-1.5">
        <MarkdownContent
          content={data.markdownContent}
          className="text-xs leading-relaxed text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        />
      </div>
    )
  } else if (data.lines.length > 0) {
    content = (
      <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs leading-snug font-mono text-foreground">
        {data.lines.map((line) => line.text).join("\n")}
      </pre>
    )
  }

  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow />
      <div className="relative min-w-0">
        {preview.title && (
          <h4 className="text-sm font-semibold leading-snug text-foreground line-clamp-1">{preview.title}</h4>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
          {preview.previewData && "repository" in preview.previewData && preview.previewData.repository.fullName}
          {" · "}
          {data.ref}
          {data.language ? ` · ${data.language}` : ""}
          {data.renderMode !== "markdown" ? ` · ${formatLineRange(data)}` : ""}
        </p>

        {content}

        {data.truncated && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {data.renderMode === "markdown"
              ? "Showing the beginning of the file only."
              : "Showing the first snippet lines only."}
          </p>
        )}
      </div>
    </div>
  )
}

function GitHubDiffContent({ data }: { data: GitHubDiffPreviewData }) {
  const stateColor = prStateColor(data.pullRequest.state)

  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow color={stateColor} />
      <div className="relative min-w-0">
        <h4 className="text-sm font-semibold leading-snug text-foreground line-clamp-1">{data.path}</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          PR #{data.pullRequest.number} · {data.pullRequest.title} · {capitalizeChangeType(data.changeType)}
          {data.language ? ` · ${data.language}` : ""}
          {formatDiffAnchor(data)}
        </p>
        {data.previousPath && data.previousPath !== data.path && (
          <p className="mt-1 text-[11px] text-muted-foreground">Renamed from {data.previousPath}</p>
        )}

        <div className="mt-2 overflow-hidden rounded-md border bg-muted/20">
          <div className="overflow-x-auto font-mono text-xs leading-snug text-foreground">
            {data.lines.map((line, index) => (
              <div
                key={`${line.oldNumber ?? "x"}-${line.newNumber ?? "x"}-${index}`}
                className={cn(
                  "grid grid-cols-[2.75rem_2.75rem_1fr] items-start",
                  line.type === "add" && "bg-green-500/10",
                  line.type === "delete" && "bg-red-500/10",
                  line.selected && "bg-primary/10 ring-1 ring-inset ring-primary/20"
                )}
              >
                <span className="px-2 py-1 text-right text-muted-foreground">{line.oldNumber ?? ""}</span>
                <span className="px-2 py-1 text-right text-muted-foreground">{line.newNumber ?? ""}</span>
                <span className="px-2 py-1 whitespace-pre">
                  <span
                    className={cn(
                      "mr-2 inline-block w-3 text-center",
                      line.type === "add" && "text-green-700 dark:text-green-300",
                      line.type === "delete" && "text-red-700 dark:text-red-300",
                      line.type === "context" && "text-muted-foreground"
                    )}
                  >
                    {getDiffLinePrefix(line.type)}
                  </span>
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <DiffStats additions={data.additions} deletions={data.deletions} />
          {data.truncated && (
            <span>
              {data.anchorStartLine ? "Showing the linked diff hunk only." : "Showing the beginning of the diff only."}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function GitHubCommentContent({ data }: { data: GitHubCommentPreviewData }) {
  const parentLabel = data.parent.kind === "pull_request" ? "PR" : "Issue"

  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow />
      <div className="relative flex items-start gap-2.5">
        <ActorAvatar actor={data.author} className="mt-0.5 ring-2 ring-background" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground line-clamp-1">
            <span className="font-semibold text-foreground">{data.author?.login ?? "Unknown"}</span>
            {" commented on "}
            {parentLabel} #{data.parent.number}
          </p>
          {data.body && (
            <div className="mt-2 flex gap-2">
              <div className="w-0.5 shrink-0 rounded-full bg-primary/40" />
              <div className="min-w-0 flex-1 rounded-r-lg bg-muted/25 py-1 pr-2">
                <MarkdownContent
                  content={data.body}
                  className="text-xs leading-relaxed text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                />
              </div>
            </div>
          )}
          {data.truncated && <p className="mt-1.5 text-[11px] text-muted-foreground">Comment truncated</p>}
        </div>
      </div>
    </div>
  )
}

function ActorAvatar({ actor, className }: { actor: GitHubPreviewActor | null; className?: string }) {
  if (!actor) return null
  return (
    <Avatar className={cn("h-5 w-5 shrink-0", className)}>
      {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt={actor.login} /> : null}
      <AvatarFallback className="text-[10px]">{actor.login.charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  )
}

function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      {additions > 0 && <span className="text-green-600 dark:text-green-400">+{additions}</span>}
      {deletions > 0 && <span className="text-red-600 dark:text-red-400">-{deletions}</span>}
    </span>
  )
}

function formatLineRange(data: GitHubFilePreviewData): string {
  return data.startLine === data.endLine ? `L${data.startLine}` : `L${data.startLine}-L${data.endLine}`
}

function formatDiffAnchor(data: GitHubDiffPreviewData): string {
  if (!data.anchorSide || !data.anchorStartLine) return ""
  const prefix = data.anchorSide === "left" ? " L" : " R"
  if (!data.anchorEndLine || data.anchorEndLine === data.anchorStartLine) {
    return `${prefix}${data.anchorStartLine}`
  }
  return `${prefix}${data.anchorStartLine}-${data.anchorEndLine}`
}

function capitalizeChangeType(changeType: GitHubDiffPreviewData["changeType"]): string {
  return changeType.charAt(0).toUpperCase() + changeType.slice(1)
}

function getDiffLinePrefix(type: GitHubDiffPreviewData["lines"][number]["type"]): string {
  if (type === "add") return "+"
  if (type === "delete") return "-"
  return " "
}

function LinearTypeIcon({ type }: { type: LinearPreview["type"] }) {
  switch (type) {
    case "linear_issue":
      return <CircleDot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    case "linear_comment":
      return <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    case "linear_project":
      return <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    case "linear_document":
      return <File className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    default:
      return <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
  }
}

function LinearContent({ preview }: { preview: LinearPreview }) {
  switch (preview.type) {
    case "linear_issue":
      return <LinearIssueContent data={preview.data as LinearIssuePreviewData} />
    case "linear_comment":
      return <LinearCommentContent data={preview.data as LinearCommentPreviewData} />
    case "linear_project":
      return <LinearProjectContent data={preview.data as LinearProjectPreviewData} />
    case "linear_document":
      return <LinearDocumentContent data={preview.data as LinearDocumentPreviewData} />
    default:
      return null
  }
}

function LinearIssueContent({ data }: { data: LinearIssuePreviewData }) {
  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow color={data.state.color} />
      <div className="relative flex items-start gap-2.5">
        <LinearActorAvatar actor={data.assignee} className="mt-0.5 ring-2 ring-background" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatePill color={data.state.color}>{data.state.name}</StatePill>
            <MonoTag>{data.identifier}</MonoTag>
          </div>
          <h4 className="mt-1.5 text-sm font-semibold leading-snug text-foreground line-clamp-2">{data.title}</h4>
          {data.summary && (
            <div className="mt-2.5 border-l-2 pl-2.5" style={{ borderColor: colorWithAlpha(data.state.color, 0.65) }}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">Summary</p>
              <div className="mt-1 overflow-hidden text-xs leading-relaxed text-foreground/90 line-clamp-3">
                <MarkdownContent
                  content={data.summary}
                  className="text-xs leading-relaxed text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                />
              </div>
            </div>
          )}
          <FieldGrid className="mt-3">
            <Field label="Status">{data.state.name}</Field>
            {data.assignee && <Field label="Assignee">@{data.assignee.displayName}</Field>}
            {data.projectName && <Field label="Project">{data.projectName}</Field>}
            {data.priority && <Field label="Priority">{data.priority.label}</Field>}
          </FieldGrid>
          {data.labels.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {data.labels.slice(0, 5).map((label) => (
                <LabelChip key={label.name} color={label.color}>
                  {label.name}
                </LabelChip>
              ))}
              {data.labels.length > 5 && (
                <span className="self-center text-[11px] text-muted-foreground">+{data.labels.length - 5}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function LinearCommentContent({ data }: { data: LinearCommentPreviewData }) {
  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow color={data.parent.state.color} />
      <div className="relative flex items-start gap-2.5">
        <LinearActorAvatar actor={data.author} className="mt-0.5 ring-2 ring-background" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
            <span className="font-semibold text-foreground">{data.author?.displayName ?? "Unknown"}</span>
            <span className="text-muted-foreground">commented on</span>
            <MonoTag>{data.parent.identifier}</MonoTag>
          </div>
          <p className="mt-1 text-xs font-medium leading-snug text-foreground line-clamp-2">{data.parent.title}</p>
          {data.body && (
            <div className="mt-2.5 flex gap-2">
              <div
                className="w-0.5 shrink-0 rounded-full"
                style={{ backgroundColor: colorWithAlpha(data.parent.state.color, 0.75) }}
              />
              <div className="min-w-0 flex-1 rounded-r-lg bg-muted/25 py-1 pr-2">
                <MarkdownContent
                  content={data.body}
                  className="text-xs leading-relaxed text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                />
              </div>
            </div>
          )}
          {data.truncated && <p className="mt-1.5 text-[11px] text-muted-foreground">Comment truncated</p>}
        </div>
      </div>
    </div>
  )
}

function LinearProjectContent({ data }: { data: LinearProjectPreviewData }) {
  const progressPct = Math.max(0, Math.min(100, Math.round(data.progress * 100)))
  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow color="#5E6AD2" />
      <div className="relative flex items-start gap-2.5">
        <LinearActorAvatar actor={data.lead} className="mt-0.5 ring-2 ring-background" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {data.status && (
              <span className="rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">
                {formatLinearStatus(data.status)}
              </span>
            )}
            <span className="text-[10px] font-medium text-muted-foreground">Project</span>
          </div>
          <h4 className="mt-1.5 text-sm font-semibold leading-snug text-foreground line-clamp-2">{data.name}</h4>
          {data.description && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground line-clamp-2">{data.description}</p>
          )}
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${progressPct}%` }} />
          </div>
          <FieldGrid className="mt-2.5">
            <Field label="Progress">{progressPct}%</Field>
            {data.lead && <Field label="Lead">@{data.lead.displayName}</Field>}
            {data.initiativeName && <Field label="Initiative">{data.initiativeName}</Field>}
            {data.targetDate && <Field label="Target">{data.targetDate}</Field>}
          </FieldGrid>
        </div>
      </div>
    </div>
  )
}

function LinearDocumentContent({ data }: { data: LinearDocumentPreviewData }) {
  return (
    <div className="relative overflow-hidden p-3">
      <AccentGlow color="#5E6AD2" />
      <div className="relative flex items-start gap-2.5">
        <LinearActorAvatar actor={data.updatedBy} className="mt-0.5 ring-2 ring-background" />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold leading-snug text-foreground line-clamp-2">{data.title}</h4>
          {data.parentProject && <p className="mt-0.5 text-xs text-muted-foreground">in {data.parentProject.name}</p>}
          {data.summary && <p className="mt-1.5 text-xs text-muted-foreground line-clamp-3">{data.summary}</p>}
        </div>
      </div>
    </div>
  )
}

function LinearActorAvatar({ actor, className }: { actor: LinearActor | null; className?: string }) {
  if (!actor) return null
  return (
    <Avatar className={cn("h-5 w-5 shrink-0", className)}>
      {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt={actor.displayName} /> : null}
      <AvatarFallback className="text-[10px]">{actor.displayName.charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  )
}

function formatLinearStatus(status: string): string {
  return status
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
