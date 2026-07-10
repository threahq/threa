import { useEffect, useRef, useState } from "react"
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Bot,
  Check,
  Copy,
  ExternalLink,
  Hash,
  MessageSquareQuote,
  Pencil,
} from "lucide-react"
import { Link } from "react-router-dom"
import { MEMO_ABSTRACT_MAX_CHARS, MEMO_TITLE_MAX_CHARS, type StreamType } from "@threa/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { RelativeTime } from "@/components/relative-time"
import { cn } from "@/lib/utils"
import { buildMemoLink } from "@/lib/memo-url"
import { streamFallbackLabel } from "@/lib/streams"
import { getKnowledgeConfig, memoLabel } from "@/lib/memo-display"
import type { MemoExplorerDetail, MemoExplorerStreamRef, MemoUpdateRequest } from "@/api"

/**
 * Full memo detail renderer — title, abstract, key points, provenance, and
 * source messages. Shared by the memory explorer page (`MemoryPage`) and the
 * in-stream memo preview dialog (`MemoPreviewDialog`) so both surfaces render
 * a memo identically. `KnowledgeTypeBadge` and `formatStreamRef` are also
 * exported because the explorer's result list composes its own memo rows.
 *
 * Editing is opt-in: pass `edit` to enable the explorer's correct/retire
 * controls. The preview dialog omits it and stays read-only.
 */

/** Correct/retire controls, supplied by the memory explorer only. */
export interface MemoEditControls {
  onSave: (fields: MemoUpdateRequest) => Promise<void>
  onArchive: () => Promise<void>
  onUnarchive: () => Promise<void>
  isMutating: boolean
}

export function formatStreamRef(stream: MemoExplorerStreamRef | null): string | null {
  if (!stream) return null

  if (stream.name) {
    return stream.type === "channel" && !stream.name.startsWith("#") ? `#${stream.name}` : stream.name
  }

  return streamFallbackLabel(stream.type as StreamType, "generic")
}

function buildSourceLink(workspaceId: string, streamId: string, messageId?: string): string {
  const search = messageId ? `?m=${messageId}` : ""
  return `/w/${workspaceId}/s/${streamId}${search}`
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function KnowledgeTypeBadge({ type, size = "sm" }: { type: string; size?: "sm" | "xs" }) {
  const config = getKnowledgeConfig(type)
  const Icon = config.icon

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border font-medium",
        config.className,
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-1.5 py-px text-[10px]"
      )}
    >
      <Icon className={size === "sm" ? "h-3 w-3" : "h-2.5 w-2.5"} />
      {config.label}
    </span>
  )
}

function DetailSection({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">{title}</h3>
      {children}
    </section>
  )
}

function MemoEditForm({
  detail,
  controls,
  onDone,
}: {
  detail: MemoExplorerDetail
  controls: MemoEditControls
  onDone: () => void
}) {
  const [title, setTitle] = useState(detail.memo.title)
  const [abstract, setAbstract] = useState(detail.memo.abstract)
  const [keyPointsText, setKeyPointsText] = useState(detail.memo.keyPoints.join("\n"))
  const [tagsText, setTagsText] = useState(detail.memo.tags.join(", "))

  const trimmedTitle = title.trim()
  const trimmedAbstract = abstract.trim()
  const nextKeyPoints = keyPointsText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const nextTags = tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)

  // Only send fields the user actually changed: a title/tags-only edit skips
  // the server-side re-embed, and untouched fields aren't overwritten (so a
  // concurrent edit to a field this user never touched survives).
  const changedFields: MemoUpdateRequest = {}
  if (trimmedTitle !== detail.memo.title) changedFields.title = trimmedTitle
  if (trimmedAbstract !== detail.memo.abstract) changedFields.abstract = trimmedAbstract
  if (!arraysEqual(nextKeyPoints, detail.memo.keyPoints)) changedFields.keyPoints = nextKeyPoints
  if (!arraysEqual(nextTags, detail.memo.tags)) changedFields.tags = nextTags

  const hasChanges = Object.keys(changedFields).length > 0
  const withinCaps =
    trimmedTitle.length > 0 &&
    trimmedTitle.length <= MEMO_TITLE_MAX_CHARS &&
    trimmedAbstract.length > 0 &&
    trimmedAbstract.length <= MEMO_ABSTRACT_MAX_CHARS
  const canSave = hasChanges && withinCaps && !controls.isMutating

  async function handleSave() {
    if (!withinCaps || controls.isMutating) return
    if (!hasChanges) {
      onDone()
      return
    }
    try {
      await controls.onSave(changedFields)
      onDone()
    } catch {
      // The page surfaces the error; keep the editor open with the draft intact.
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Title</label>
        <Input
          value={title}
          maxLength={MEMO_TITLE_MAX_CHARS}
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            Abstract
          </label>
          <span className="text-[10px] tabular-nums text-muted-foreground/50">
            {trimmedAbstract.length}/{MEMO_ABSTRACT_MAX_CHARS}
          </span>
        </div>
        <Textarea
          value={abstract}
          maxLength={MEMO_ABSTRACT_MAX_CHARS}
          rows={4}
          onChange={(event) => setAbstract(event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          Key points <span className="font-normal normal-case text-muted-foreground/40">(one per line)</span>
        </label>
        <Textarea value={keyPointsText} rows={4} onChange={(event) => setKeyPointsText(event.target.value)} />
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          Tags <span className="font-normal normal-case text-muted-foreground/40">(comma separated)</span>
        </label>
        <Input value={tagsText} onChange={(event) => setTagsText(event.target.value)} />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={!canSave}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={controls.isMutating}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Agent-provenance badge (roadmap 6.6): an agent-authored memo (`save_memo` /
 * reflective capture) must be legible as such wherever it renders, so a reader
 * can weigh it differently from conversation-extracted knowledge.
 */
export function AgentAuthoredBadge({ personaName }: { personaName?: string | null }) {
  return (
    <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
      <Bot className="h-2.5 w-2.5" />
      {personaName ? `Captured by ${personaName}` : "AI-captured"}
    </Badge>
  )
}

function MemoStatusBadge({ status }: { status: string }) {
  if (status === "archived") {
    return (
      <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
        <Archive className="h-2.5 w-2.5" />
        Archived
      </Badge>
    )
  }
  if (status === "superseded") {
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        Superseded
      </Badge>
    )
  }
  return null
}

/**
 * Copies the memo's shareable resource URL. Confirms in place by swapping the
 * icon to a checkmark rather than toasting (INV-63) — the label stays fixed so
 * the button's footprint doesn't shift (INV-21).
 */
function CopyMemoLinkButton({ workspaceId, memoId }: { workspaceId: string; memoId: string }) {
  const [copied, setCopied] = useState(false)
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest memo under the button — read after the async copy to tell whether the
  // memo switched while the write was in flight.
  const memoIdRef = useRef(memoId)
  memoIdRef.current = memoId

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current)
    },
    []
  )

  // Clear the confirmation when the memo changes so a checkmark from one memo
  // never lingers onto the next — the preview dialog reuses this instance across
  // memo switches rather than remounting it.
  useEffect(() => {
    setCopied(false)
    if (resetRef.current) clearTimeout(resetRef.current)
  }, [memoId])

  async function handleCopy() {
    const target = memoId
    try {
      await navigator.clipboard.writeText(buildMemoLink(workspaceId, target))
    } catch {
      return
    }
    // If the memo switched while the write was pending, the clipboard holds
    // `target`'s URL, not the one now on screen — don't flash a false confirm.
    if (memoIdRef.current !== target) return
    setCopied(true)
    if (resetRef.current) clearTimeout(resetRef.current)
    resetRef.current = setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn("h-7 gap-1.5 px-2 text-xs", copied && "text-emerald-500")}
      onClick={() => void handleCopy()}
      // Accessible name stays a superset of the visible "Copy link" so voice
      // control matches and WCAG 2.5.3 (Label in Name) holds; only the copied
      // suffix changes — the visible text is fixed, so nothing shifts (INV-21).
      aria-label={copied ? "Copy link, copied" : undefined}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      Copy link
    </Button>
  )
}

export function MemoDetailContent({
  data,
  workspaceId,
  isLoading,
  edit,
}: {
  data: MemoExplorerDetail | null
  workspaceId: string
  isLoading: boolean
  edit?: MemoEditControls
}) {
  const [isEditing, setIsEditing] = useState(false)

  // Leave edit mode when the selected memo changes so a fresh memo never opens
  // pre-populated with the previous one's draft.
  const memoId = data?.memo.id ?? null
  useEffect(() => {
    setIsEditing(false)
  }, [memoId])

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-16 w-full" />
        </div>
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="rounded-full bg-muted/50 p-4 mb-4">
          <BookOpen className="h-6 w-6 text-muted-foreground/30" />
        </div>
        <p className="text-sm text-muted-foreground/60">Select a memo to view its details and provenance</p>
      </div>
    )
  }

  const isArchived = data.memo.status === "archived"
  const isActive = data.memo.status === "active"

  return (
    // [overflow-wrap:anywhere] is inherited by descendants so long unbreakable
    // strings collapse in min-content calculations. Without this, the Radix
    // ScrollArea / Drawer viewport can be forced wider than the screen on mobile.
    <div className="min-w-0 space-y-8 [overflow-wrap:anywhere]">
      <div className="min-w-0">
        {/* Metadata and actions are separate flex groups so the action buttons
            never wrap into the badge row (they'd orphan right-flush on a phone);
            justify-between keeps them side-by-side on desktop and stacked on narrow. */}
        <div className="mb-3 flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <KnowledgeTypeBadge type={data.memo.knowledgeType} size="sm" />
            <Badge variant="secondary" className="text-[10px] font-medium">
              {memoLabel(data.memo.memoType)}
            </Badge>
            <MemoStatusBadge status={data.memo.status} />
            {data.memo.authoredByKind === "agent" && <AgentAuthoredBadge personaName={data.capturedByPersonaName} />}
            <span className="text-[11px] tabular-nums text-muted-foreground/50">v{data.memo.version}</span>
            <span className="text-muted-foreground/30">&middot;</span>
            <RelativeTime date={data.memo.updatedAt} className="text-[11px] text-muted-foreground/50" />
          </div>

          {!isEditing && (
            <div className="flex shrink-0 items-center gap-2">
              <CopyMemoLinkButton workspaceId={workspaceId} memoId={data.memo.id} />
              {edit && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-xs"
                    onClick={() => setIsEditing(true)}
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </Button>
                  {isArchived && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 px-2 text-xs"
                      disabled={edit.isMutating}
                      onClick={() => void edit.onUnarchive()}
                    >
                      <ArchiveRestore className="h-3 w-3" />
                      Restore
                    </Button>
                  )}
                  {isActive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                      disabled={edit.isMutating}
                      onClick={() => void edit.onArchive()}
                    >
                      <Archive className="h-3 w-3" />
                      Archive
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {edit && isEditing ? (
          <MemoEditForm detail={data} controls={edit} onDone={() => setIsEditing(false)} />
        ) : (
          <>
            <h2 className="text-xl font-semibold tracking-tight leading-tight">{data.memo.title}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{data.memo.abstract}</p>

            {data.successorMemoId && (
              <Link
                to={`/w/${workspaceId}/memory?memo=${data.successorMemoId}`}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
              >
                Replaced by a newer memo
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/40" />
              </Link>
            )}

            {data.memo.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {data.memo.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    <Hash className="h-2.5 w-2.5 shrink-0" />
                    <span className="min-w-0 truncate">{tag}</span>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {!isEditing && data.memo.keyPoints.length > 0 && (
        <DetailSection title="Key points">
          <ul className="space-y-2">
            {data.memo.keyPoints.map((keyPoint) => (
              <li
                key={keyPoint}
                className="relative min-w-0 pl-4 text-sm leading-relaxed before:absolute before:left-0 before:top-[0.6em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-primary/40"
              >
                {keyPoint}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      <DetailSection title="Provenance">
        {data.memo.authoredByKind === "agent" && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Bot className="h-3.5 w-3.5 shrink-0" />
            Written by {data.capturedByPersonaName ?? "an AI agent"} from its own session work, not extracted from a
            team conversation.
          </p>
        )}
        <div className="flex min-w-0 flex-wrap gap-2">
          {data.sourceStream && (
            <Link
              to={buildSourceLink(workspaceId, data.sourceStream.id)}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-card px-3 py-2 text-sm transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <MessageSquareQuote className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-medium">{formatStreamRef(data.sourceStream)}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/40" />
            </Link>
          )}

          {data.rootStream && data.rootStream.id !== data.sourceStream?.id && (
            <Link
              to={buildSourceLink(workspaceId, data.rootStream.id)}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-card px-3 py-2 text-sm transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <span className="shrink-0 text-xs text-muted-foreground/60">in</span>
              <span className="min-w-0 truncate font-medium">{formatStreamRef(data.rootStream)}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/40" />
            </Link>
          )}

          {!data.sourceStream && !data.rootStream && (
            <span className="text-sm text-muted-foreground/50">Source unavailable</span>
          )}
        </div>
      </DetailSection>

      <DetailSection title="Source messages">
        {data.sourceMessages.length === 0 ? (
          <p className="text-sm text-muted-foreground/50">No accessible source messages were retained for this memo.</p>
        ) : (
          <div className="space-y-3">
            {data.sourceMessages.map((message) => (
              <div key={message.id} className="min-w-0 overflow-hidden rounded-lg border border-border/50 bg-card">
                <div className="flex min-w-0 items-center gap-2 border-b border-border/30 px-4 py-2">
                  <span className="min-w-0 truncate text-xs font-semibold">{message.authorName}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/40">in</span>
                  <Link
                    to={buildSourceLink(workspaceId, message.streamId, message.id)}
                    className="min-w-0 truncate text-xs text-primary/80 hover:text-primary hover:underline"
                  >
                    {message.streamName}
                  </Link>
                  <span className="ml-auto shrink-0">
                    <RelativeTime
                      date={message.createdAt}
                      className="text-[10px] tabular-nums text-muted-foreground/40"
                    />
                  </span>
                </div>
                <div className="min-w-0 overflow-hidden px-4 py-3 text-sm leading-relaxed">
                  <MarkdownContent content={message.content} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
                </div>
              </div>
            ))}
          </div>
        )}
      </DetailSection>
    </div>
  )
}
