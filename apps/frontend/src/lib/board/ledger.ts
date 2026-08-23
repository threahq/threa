import {
  DelegationStatuses,
  isInAppLinkContentType,
  LinkPreviewContentTypes,
  type AgentFollowUpScheduledEventPayload,
  type AgentSessionCompletedPayload,
  type AgentSessionFailedPayload,
  type AgentSessionStartedPayload,
  type AsideAnchoredEventPayload,
  type AttachmentSummary,
  type CommandDispatchedPayload,
  type DelegationCreatedEventPayload,
  type LinkPreviewContentType,
  type LinkPreviewSummary,
  type MemosCapturedEventPayload,
} from "@threa/types"

import type { BoardEventRow } from "@/lib/board/board-event-rows"
import { delegationAvailabilityLabel } from "@/lib/delegation-display"
import { formatDuration, formatFireTime } from "@/lib/dates"
import { resolveEmojiShortcodes, stripMarkdownKeepingCode, truncateInline } from "@/lib/markdown/strip"

/** Longest link-preview title that reads as a label; longer ones fall back to the hostname. */
const MAX_LINK_TITLE_CHARS = 28

/**
 * The first meaningful line of a message, as inline text (INV-60 — the strip is
 * the shared `@threa/types` one, never a parallel implementation).
 *
 * The whole markdown is stripped before the split: fences are block-level, so a
 * line-first split would leave a bare ``` behind instead of the code's first
 * line. The per-line pass is emoji-only — re-stripping markdown here would
 * re-interpret fence-extracted code (`# comment`, `> out.txt`) as markdown.
 * Lines that strip to nothing (dividers, alt-less images, empty headings) are
 * skipped. Returns "" when nothing survives — the caller picks the fallback.
 */
export function leadLine(
  contentMarkdown: string,
  maxChars: number,
  toEmoji?: (shortcode: string) => string | null
): string {
  for (const line of stripMarkdownKeepingCode(contentMarkdown).split("\n")) {
    const inline = resolveEmojiShortcodes(line, toEmoji).trim()
    if (!inline) continue
    return truncateInline(inline, maxChars)
  }
  return ""
}

/** The row fields the effective-unread derivation reads, structurally. */
export interface UnreadCandidate {
  id: string
  streamId?: string
  sequence?: string
  authorId: string
  createdAt: string | Date
  contentMarkdown: string
}

export interface EffectiveUnreadCtx {
  currentUserId: string | null | undefined
  /** Stream a row without one of its own belongs to (the card's anchor). */
  fallbackStreamId: string
  state: (
    streamId: string,
    messageId: string,
    sequence: string | undefined,
    createdAt: string | Date
  ) => "read" | "unread" | "ungated"
}

/**
 * The single "effectively unread for this viewer" decision every conversation
 * surface reads (INV-35): the header dot, the ledger lead's tint and the mass
 * badge's count all call this, so a row can never be tinted but uncounted. Live
 * off the read overlay + per-stream frontiers — never the latched divider
 * position, which is a one-way per-open decision.
 */
export function isEffectivelyUnread(message: UnreadCandidate, ctx: EffectiveUnreadCtx): boolean {
  return (
    message.authorId !== ctx.currentUserId &&
    ctx.state(message.streamId ?? ctx.fallbackStreamId, message.id, message.sequence, message.createdAt) === "unread"
  )
}

export interface UnreadMass {
  count: number
}

/**
 * How many unread messages the given rows carry. Callers pass the rows they KNOW
 * (the card's readable rows, including the ones hidden behind the head row —
 * off-card unread is exactly what the badge exists to signal). Replies the rail
 * has never synced are outside the count.
 */
export function unreadMass(messages: UnreadCandidate[], ctx: EffectiveUnreadCtx): UnreadMass {
  let count = 0
  for (const message of messages) {
    if (isEffectivelyUnread(message, ctx)) count += 1
  }
  return { count }
}

/** The `RenderableMessage` fields the artifact row reads, structurally. */
export interface LedgerArtifactSource {
  attachments?: AttachmentSummary[]
  linkPreviews?: LinkPreviewSummary[]
}

export interface RowArtifacts {
  attachmentCount: number
  firstLinkLabel: string | null
}

export function rowArtifacts(message: LedgerArtifactSource): RowArtifacts {
  const preview = (message.linkPreviews ?? []).find((p) => p.contentType !== LinkPreviewContentTypes.STREAM_LINK)
  return {
    attachmentCount: message.attachments?.length ?? 0,
    firstLinkLabel: preview ? linkLabel(preview) : null,
  }
}

/**
 * In-app previews are stored without a title — the target resolves per-viewer —
 * so the kind noun is the only honest label; the hostname would read
 * "app.threa.io" on every one.
 */
const IN_APP_LINK_NOUNS: Partial<Record<LinkPreviewContentType, string>> = {
  [LinkPreviewContentTypes.MESSAGE_LINK]: "message",
  [LinkPreviewContentTypes.MEMO_LINK]: "memo",
  [LinkPreviewContentTypes.CONVERSATION_LINK]: "conversation",
  [LinkPreviewContentTypes.DELEGATION_LINK]: "delegation",
}

export function linkLabel(preview: LinkPreviewSummary): string {
  if (isInAppLinkContentType(preview.contentType)) return IN_APP_LINK_NOUNS[preview.contentType] ?? "link"
  const title = preview.title?.trim()
  if (title && title.length < MAX_LINK_TITLE_CHARS) return title
  return hostname(preview.url)
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/**
 * The renderable content of one ledger event line — everything the thin row
 * shows, plus the in-app detail target when the kind has one. Data only: the
 * surface picks the icon, turns `href` into a `<Link>` (INV-40), and maps
 * `memo` onto the same in-place `MemoPreviewDialog` the full capture row opens.
 */
export interface LedgerEventContent {
  key: string
  kind: BoardEventRow["kind"]
  label: string
  meta?: string
  href?: string
  /** The single memo a capture line previews in place. */
  memo?: { memoId: string; title: string }
}

export interface LedgerEventContentCtx {
  /** The session's trace-view URL, from the surface's `useTrace`. */
  traceUrl: (sessionId: string) => string
  /** An aside's title from the creator's stream cache; null when not cached. */
  asideTitle?: (asideId: string) => string | null
}

function stepsLabel(count: number): string {
  return `${count} ${count === 1 ? "step" : "steps"}`
}

/**
 * A board event row compressed to its ledger line. Titles and counts only —
 * a capture line carries its memos' TITLES, never their content (INV-69): the
 * memo body is the preview dialog's, one tap away.
 */
export function ledgerEventContent(row: BoardEventRow, ctx: LedgerEventContentCtx): LedgerEventContent {
  switch (row.kind) {
    case "session": {
      let sessionId = ""
      let personaName: string | null = null
      let completed: AgentSessionCompletedPayload | null = null
      let failed: AgentSessionFailedPayload | null = null
      let interrupted = false
      let deleted = false
      for (const event of row.events) {
        const id = (event.payload as { sessionId?: string } | undefined)?.sessionId
        if (id) sessionId = id
        switch (event.eventType) {
          case "agent_session:started":
            personaName = (event.payload as AgentSessionStartedPayload | undefined)?.personaName ?? null
            break
          case "agent_session:completed":
            completed = event.payload as AgentSessionCompletedPayload
            break
          case "agent_session:failed":
            failed = event.payload as AgentSessionFailedPayload
            break
          case "agent_session:interrupted":
            interrupted = true
            break
          case "agent_session:deleted":
            deleted = true
            break
        }
      }
      // Same precedence the full card derives: deleted › completed › failed ›
      // interrupted, so a retried session never reads as finished.
      let meta: string
      if (deleted) meta = "deleted"
      else if (completed) meta = `${stepsLabel(completed.stepCount)} · ${formatDuration(completed.duration)}`
      else if (failed) meta = `${stepsLabel(failed.stepCount)} · failed`
      else if (interrupted) meta = "retrying"
      else meta = "running"
      return {
        key: row.key,
        kind: "session",
        label: personaName ?? "Agent",
        meta,
        href: sessionId ? ctx.traceUrl(sessionId) : undefined,
      }
    }
    case "command": {
      const dispatched = row.events.find((event) => event.eventType === "command_dispatched")
      const name = (dispatched?.payload as CommandDispatchedPayload | undefined)?.name
      let meta = "running"
      if (row.events.some((event) => event.eventType === "command_failed")) meta = "failed"
      else if (row.events.some((event) => event.eventType === "command_completed")) meta = "completed"
      return {
        key: row.key,
        kind: "command",
        label: name ? `/${name}` : "Command",
        meta,
      }
    }
    case "memo": {
      const memos = (row.event.payload as MemosCapturedEventPayload | undefined)?.memos ?? []
      const titles = memos.map((memo) => memo.title)
      return {
        key: row.key,
        kind: "memo",
        label: titles.length === 0 ? "Memo captured" : `Memo: ${titles.join(", ")}`,
        // One memo has an unambiguous target; a batch would have to pick one, so
        // it stays a plain line and the reader opens what they want in the panel.
        memo: memos.length === 1 ? { memoId: memos[0].memoId, title: memos[0].title } : undefined,
      }
    }
    case "followUp": {
      const payload = row.event.payload as AgentFollowUpScheduledEventPayload | undefined
      let meta: string | undefined
      if (row.cancelled) meta = "cancelled"
      else if (payload) meta = `fires ${formatFireTime(new Date(payload.scheduledFor))}`
      return {
        key: row.key,
        kind: "followUp",
        label: payload?.note ? `Follow-up: ${payload.note}` : "Follow-up scheduled",
        meta,
      }
    }
    case "delegation": {
      const payload = row.event.payload as DelegationCreatedEventPayload | undefined
      return {
        key: row.key,
        kind: "delegation",
        label: payload?.title ? `Delegation: ${payload.title}` : "Delegation",
        meta: delegationAvailabilityLabel(row.statusPatch?.status ?? DelegationStatuses.OPEN, row.statusPatch?.reason),
      }
    }
    case "aside": {
      const payload = row.event.payload as AsideAnchoredEventPayload | undefined
      const title = payload ? ctx.asideTitle?.(payload.asideId) : null
      return {
        key: row.key,
        kind: "aside",
        label: title ? `Aside: ${title}` : "Aside",
      }
    }
    default: {
      const exhaustive: never = row
      return exhaustive
    }
  }
}

export type LedgerItemKind = "message" | "event"

export interface LedgerEventGroup<T> {
  kind: "event-group"
  events: T[]
}

/**
 * Fold adjacent runs of two or more events into one group; single events and
 * messages pass through untouched. Pure and order-preserving.
 */
export function coalesceLedgerItems<T extends { kind: LedgerItemKind }>(items: T[]): Array<T | LedgerEventGroup<T>> {
  const out: Array<T | LedgerEventGroup<T>> = []
  let run: T[] = []

  const flush = () => {
    if (run.length >= 2) out.push({ kind: "event-group", events: run })
    else out.push(...run)
    run = []
  }

  for (const item of items) {
    if (item.kind === "event") {
      run.push(item)
      continue
    }
    flush()
    out.push(item)
  }
  flush()
  return out
}
