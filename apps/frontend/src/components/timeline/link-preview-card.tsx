import { useState, useCallback } from "react"
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
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { cn } from "@/lib/utils"
import { LinkPreviewBody } from "./link-preview-body"
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
} from "@threa/types"

function isLinearPreview(preview: GitHubPreview | LinearPreview | null | undefined): preview is LinearPreview {
  return !!preview && typeof preview.type === "string" && preview.type.startsWith("linear_")
}

interface LinkPreviewCardProps {
  preview: LinkPreviewSummary
  /**
   * Scopes the per-preview "Show more" persistence key. Optional so tests and
   * transient previews without a host message still render.
   */
  messageId?: string
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
  isHighlighted,
  isCollapsed: isCollapsedProp,
  onDismiss,
  onToggleCollapse,
}: LinkPreviewCardProps) {
  const [imageError, setImageError] = useState(false)
  const domain = getDomain(preview.url)
  const providerPreview = preview.previewData
  const githubPreview = providerPreview && !isLinearPreview(providerPreview) ? providerPreview : null
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
    return (
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "group/preview relative block overflow-hidden rounded-lg border bg-muted/30 transition-all max-w-xs",
          "hover:border-primary hover:shadow-sm",
          isHighlighted && "ring-2 ring-primary border-primary shadow-sm"
        )}
      >
        <div className="absolute top-1.5 right-1.5 z-10 flex gap-1 opacity-0 group-hover/preview:opacity-100 transition-opacity">
          {onDismiss && (
            <Button
              variant="secondary"
              size="icon"
              className="h-6 w-6 shadow-sm"
              onClick={handleDismiss}
              aria-label="Dismiss preview"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
        {!imageError ? (
          <img
            src={preview.url}
            alt={preview.title ?? "Image preview"}
            className="h-32 w-auto max-w-xs object-cover"
            loading="lazy"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className="flex h-32 w-40 items-center justify-center text-muted-foreground">
            <ImageIcon className="h-8 w-8" />
          </div>
        )}
        <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
          <ExternalLink className="h-3 w-3 shrink-0" />
          <span className="truncate">{domain}</span>
        </div>
      </a>
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
        "group/preview relative overflow-hidden rounded-lg border bg-card transition-all max-w-md",
        "hover:border-primary/50 hover:shadow-sm",
        isHighlighted && "ring-2 ring-primary border-primary shadow-sm"
      )}
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b bg-muted/30">
        <button
          type="button"
          onClick={handleToggleCollapse}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-label={isCollapsedProp ? "Expand preview" : "Collapse preview"}
        >
          {isCollapsedProp ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        {headerIcon}
        {!githubPreview && !linearPreview && preview.faviconUrl && (
          <img
            src={preview.faviconUrl}
            alt=""
            className="h-3.5 w-3.5 rounded-sm"
            loading="lazy"
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = "none"
            }}
          />
        )}
        <span className="text-xs text-muted-foreground truncate">{headerLabel}</span>
        <ExternalLink className="h-3 w-3 text-muted-foreground/50 shrink-0 ml-auto" />
        <div className="flex gap-1 opacity-0 group-hover/preview:opacity-100 transition-opacity">
          {onDismiss && (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={handleDismiss}
              aria-label="Dismiss preview"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

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

  // Text intentionally flows at natural height — `LinkPreviewBody` clips the
  // whole card to a shared ceiling and reveals a "Show more" toggle when
  // overflow occurs. Pre-truncating with `line-clamp-*` hid overflow from
  // `scrollHeight`, which suppressed the toggle and left blank space below.
  return (
    <div className="flex gap-4 p-3">
      <div className="flex-1 min-w-0">
        {preview.title && <h4 className="text-sm font-medium text-foreground mb-0.5">{preview.title}</h4>}
        {preview.description && <p className="text-xs text-muted-foreground">{preview.description}</p>}
        {!hasPrimaryMetadata && (
          <p className="text-xs text-muted-foreground">
            Open link: <span className="font-medium text-foreground">{fallbackLabel}</span>
          </p>
        )}
      </div>
      {preview.imageUrl && !imageError && (
        <img
          src={preview.imageUrl}
          alt=""
          className="h-16 w-24 rounded object-cover shrink-0"
          loading="lazy"
          onError={onImageError}
        />
      )}
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

function GitHubPrContent({ data }: { data: GitHubPrPreviewData }) {
  const stateLabels = { merged: "Merged", closed: "Closed", open: "Open" } as const
  const stateLabel = stateLabels[data.state]

  return (
    <div className="p-3">
      <div className="flex items-start gap-2">
        <ActorAvatar actor={data.author} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-foreground">
            {data.title}
            <span className="ml-1.5 font-normal text-muted-foreground">#{data.number}</span>
          </h4>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <PrStateBadge state={data.state} label={stateLabel} />
            <span className="truncate max-w-[10rem]" title={`${data.headBranch} → ${data.baseBranch}`}>
              {data.headBranch}
              <span className="mx-0.5">{"\u2192"}</span>
              {data.baseBranch}
            </span>
            <DiffStats additions={data.additions} deletions={data.deletions} />
          </div>
          <ReviewSummary summary={data.reviewStatusSummary} />
        </div>
      </div>
    </div>
  )
}

function PrStateBadge({ state, label }: { state: "open" | "closed" | "merged"; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-px text-[11px] font-medium leading-tight",
        state === "open" && "bg-green-500/15 text-green-600 dark:text-green-400",
        state === "merged" && "bg-purple-500/15 text-purple-600 dark:text-purple-400",
        state === "closed" && "bg-red-500/15 text-red-600 dark:text-red-400"
      )}
    >
      {label}
    </span>
  )
}

function ReviewSummary({ summary }: { summary: GitHubPrPreviewData["reviewStatusSummary"] }) {
  const parts: string[] = []
  if (summary.approvals > 0) parts.push(`${summary.approvals} approved`)
  if (summary.changesRequested > 0) parts.push(`${summary.changesRequested} changes requested`)
  if (summary.pendingReviewers > 0) parts.push(`${summary.pendingReviewers} pending`)
  if (parts.length === 0) return null

  return <p className="mt-1 text-[11px] text-muted-foreground">{parts.join(" \u00b7 ")}</p>
}

function GitHubIssueContent({ data }: { data: GitHubIssuePreviewData }) {
  return (
    <div className="p-3">
      <div className="flex items-start gap-2">
        <ActorAvatar actor={data.author} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-foreground">
            {data.title}
            <span className="ml-1.5 font-normal text-muted-foreground">#{data.number}</span>
          </h4>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-px text-[11px] font-medium leading-tight",
                data.state === "open"
                  ? "bg-green-500/15 text-green-600 dark:text-green-400"
                  : "bg-purple-500/15 text-purple-600 dark:text-purple-400"
              )}
            >
              {data.state === "open" ? "Open" : "Closed"}
            </span>
            {data.commentCount > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <MessageSquare className="h-3 w-3" />
                {data.commentCount}
              </span>
            )}
          </div>
          {data.labels.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {data.labels.slice(0, 4).map((label) => (
                <IssueLabel key={label.name} name={label.name} color={label.color} />
              ))}
              {data.labels.length > 4 && (
                <span className="text-[11px] text-muted-foreground">+{data.labels.length - 4}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function IssueLabel({ name, color }: { name: string; color: string }) {
  const hex = color.startsWith("#") ? color : `#${color}`
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-px text-[11px] font-medium leading-tight border"
      style={{
        backgroundColor: `${hex}20`,
        borderColor: `${hex}40`,
        color: hex,
      }}
    >
      {name}
    </span>
  )
}

function GitHubCommitContent({ data }: { data: GitHubCommitPreviewData }) {
  const firstLine = data.message.split("\n")[0]

  return (
    <div className="p-3">
      <div className="flex items-start gap-2">
        <ActorAvatar actor={data.author} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-foreground">{firstLine}</h4>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <code className="rounded bg-muted px-1 py-px font-mono text-[11px]">{data.shortSha}</code>
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
    <div className="p-3">
      <div className="min-w-0">
        {preview.title && <h4 className="text-sm font-medium text-foreground line-clamp-1">{preview.title}</h4>}
        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
          {preview.previewData && "repository" in preview.previewData && preview.previewData.repository.fullName}
          {" \u00b7 "}
          {data.ref}
          {data.language ? ` \u00b7 ${data.language}` : ""}
          {data.renderMode !== "markdown" ? ` \u00b7 ${formatLineRange(data)}` : ""}
        </p>
      </div>

      {content}

      {data.truncated && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {data.renderMode === "markdown"
            ? "Showing the beginning of the file only."
            : "Showing the first snippet lines only."}
        </p>
      )}
    </div>
  )
}

function GitHubDiffContent({ data }: { data: GitHubDiffPreviewData }) {
  return (
    <div className="p-3">
      <div className="min-w-0">
        <h4 className="text-sm font-medium text-foreground line-clamp-1">{data.path}</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          PR #{data.pullRequest.number} · {data.pullRequest.title} · {capitalizeChangeType(data.changeType)}
          {data.language ? ` · ${data.language}` : ""}
          {formatDiffAnchor(data)}
        </p>
        {data.previousPath && data.previousPath !== data.path && (
          <p className="mt-1 text-[11px] text-muted-foreground">Renamed from {data.previousPath}</p>
        )}
      </div>

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
  )
}

function GitHubCommentContent({ data }: { data: GitHubCommentPreviewData }) {
  const parentLabel = data.parent.kind === "pull_request" ? "PR" : "Issue"

  return (
    <div className="p-3">
      <div className="flex items-start gap-2">
        <ActorAvatar actor={data.author} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground line-clamp-1">
            <span className="font-medium text-foreground">{data.author?.login ?? "Unknown"}</span>
            {" commented on "}
            {parentLabel} #{data.parent.number}
          </p>
          {data.body && (
            <div className="mt-1.5 overflow-hidden rounded-md border bg-muted/20 px-2.5 py-1.5">
              <MarkdownContent
                content={data.body}
                className="text-xs leading-relaxed text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              />
            </div>
          )}
          {data.truncated && <p className="mt-1 text-[11px] text-muted-foreground">Comment truncated</p>}
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
      <LinearGlow color={data.state.color} />
      <div className="relative flex items-start gap-2.5">
        <LinearActorAvatar actor={data.assignee} className="mt-0.5 ring-2 ring-background" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <LinearStateBadge state={data.state} />
            <span className="rounded-full bg-muted/70 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
              {data.identifier}
            </span>
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
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <LinearField label="Status">{data.state.name}</LinearField>
            {data.assignee && <LinearField label="Assignee">@{data.assignee.displayName}</LinearField>}
            {data.projectName && <LinearField label="Project">{data.projectName}</LinearField>}
            {data.priority && <LinearField label="Priority">{data.priority.label}</LinearField>}
          </div>
          {data.labels.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {data.labels.slice(0, 5).map((label) => (
                <span
                  key={label.name}
                  className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium text-foreground/80 shadow-sm"
                  style={{
                    backgroundColor: colorWithAlpha(label.color, 0.12),
                    borderColor: colorWithAlpha(label.color, 0.28),
                  }}
                >
                  {label.name}
                </span>
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
      <LinearGlow color={data.parent.state.color} />
      <div className="relative flex items-start gap-2.5">
        <LinearActorAvatar actor={data.author} className="mt-0.5 ring-2 ring-background" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
            <span className="font-semibold text-foreground">{data.author?.displayName ?? "Unknown"}</span>
            <span className="text-muted-foreground">commented on</span>
            <span className="rounded-full bg-muted/70 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
              {data.parent.identifier}
            </span>
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
      <LinearGlow color="#5E6AD2" />
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
          <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <LinearField label="Progress">{progressPct}%</LinearField>
            {data.lead && <LinearField label="Lead">@{data.lead.displayName}</LinearField>}
            {data.initiativeName && <LinearField label="Initiative">{data.initiativeName}</LinearField>}
            {data.targetDate && <LinearField label="Target">{data.targetDate}</LinearField>}
          </div>
        </div>
      </div>
    </div>
  )
}

function LinearDocumentContent({ data }: { data: LinearDocumentPreviewData }) {
  return (
    <div className="p-3">
      <div className="flex items-start gap-2">
        <LinearActorAvatar actor={data.updatedBy} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-foreground">{data.title}</h4>
          {data.parentProject && <p className="mt-0.5 text-xs text-muted-foreground">in {data.parentProject.name}</p>}
          {data.summary && <p className="mt-1.5 text-xs text-muted-foreground line-clamp-3">{data.summary}</p>}
        </div>
      </div>
    </div>
  )
}

function LinearField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">{label}</p>
      <div className="mt-0.5 truncate font-medium text-foreground/90">{children}</div>
    </div>
  )
}

function LinearGlow({ color }: { color: string }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -right-10 -top-10 h-24 w-24 rounded-full blur-2xl"
      style={{ backgroundColor: colorWithAlpha(color, 0.13) }}
    />
  )
}

function LinearStateBadge({ state }: { state: LinearIssuePreviewData["state"] }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-tight text-foreground shadow-sm"
      style={{ backgroundColor: colorWithAlpha(state.color, 0.14), borderColor: colorWithAlpha(state.color, 0.32) }}
    >
      {state.name}
    </span>
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

function colorWithAlpha(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, "")
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `rgba(149, 162, 179, ${alpha})`
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
