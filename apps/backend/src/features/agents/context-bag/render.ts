import type { LastRenderedSnapshot, RenderableMessage, SummaryInput } from "./types"
import type { DiffResult } from "./diff"
import { renderLinkPreviewContext } from "../../link-previews"

export interface StableRenderInput {
  preamble: string
  /** When present, the stable body is rendered inline (small-thread case). */
  inlineItems?: RenderableMessage[]
  /** When present, the stable body is the cached summary (large-thread case). */
  summaryText?: string
  refLabel: string
  /**
   * The id of the message the discussion is anchored on (the user clicked
   * "Discuss with Ariadne" on it). When present and found in `inlineItems`,
   * the renderer splits the inline list into "Messages before" / "Focused
   * message" / "Messages after" sections and marks the focal with `►`.
   */
  focalMessageId?: string | null
}

/**
 * Build the stable region of the prompt. This region MUST stay byte-identical
 * across turns for already-rendered content so the Anthropic prompt-cache
 * prefix survives — do not mutate here based on later edits/deletes; those go
 * in the volatile delta region instead.
 */
export function renderStable(input: StableRenderInput): string {
  const parts: string[] = [input.preamble.trim(), "", `## Context source: ${input.refLabel}`]

  if (input.summaryText) {
    parts.push("", "Summary (cached):", input.summaryText.trim())
  } else if (input.inlineItems && input.inlineItems.length > 0) {
    const focalIdx =
      input.focalMessageId != null ? input.inlineItems.findIndex((i) => i.messageId === input.focalMessageId) : -1

    if (focalIdx < 0) {
      parts.push("", "Messages (chronological):")
      for (const item of input.inlineItems) {
        parts.push(formatInlineMessage(item))
      }
    } else {
      const before = input.inlineItems.slice(0, focalIdx)
      const focal = input.inlineItems[focalIdx]
      const after = input.inlineItems.slice(focalIdx + 1)

      if (before.length > 0) {
        parts.push("", `Messages before the focused message (${before.length}, chronological):`)
        for (const item of before) parts.push(formatInlineMessage(item))
      }
      parts.push("", "Focused message (the message the user opened this discussion from):")
      parts.push(formatInlineMessage(focal, { focal: true }))
      if (after.length > 0) {
        parts.push("", `Messages after the focused message (${after.length}, chronological):`)
        for (const item of after) parts.push(formatInlineMessage(item))
      }
    }
  } else {
    parts.push("", "(no messages in source thread yet)")
  }

  return parts.join("\n")
}

function formatInlineMessage(item: RenderableMessage, options?: { focal?: boolean }): string {
  const ts = item.createdAt
  const edited = item.editedAt ? ` (edited ${item.editedAt})` : ""
  // `►` marks the focal message inline so the model has a redundant cue
  // alongside the section header. Bullet stays a simple dash everywhere
  // else for prompt-cache stability across non-focal renders.
  const bullet = options?.focal ? "►" : "-"
  // Attachments render as a sibling line under the message body so the model
  // (and the trace UI) can see what was attached. We only carry filename +
  // mime + size — full text is loaded on demand through the existing
  // attachment tools, keeping the stable region small.
  const attachments =
    item.attachments && item.attachments.length > 0 ? `\n  ${formatAttachments(item.attachments)}` : ""
  const previewContext = renderLinkPreviewContext(item.linkPreviews ?? [])
  const linkPreviews = previewContext ? `\n  ${previewContext.replaceAll("\n", "\n  ")}` : ""
  return `${bullet} [${item.messageId}] ${item.authorName} at ${ts}${edited}:\n  ${item.contentMarkdown.replaceAll("\n", "\n  ")}${attachments}${linkPreviews}`
}

function formatAttachments(attachments: NonNullable<RenderableMessage["attachments"]>): string {
  const parts = attachments.map((a) => `[${a.id}] ${a.filename} (${a.mimeType}, ${a.sizeBytes} bytes)`)
  return `Attachments: ${parts.join("; ")}`
}

export interface DeltaRenderInput {
  diff: DiffResult
  /**
   * Lookup for current renderable content, keyed by messageId. Edits/appends
   * pull `contentMarkdown` from here; deletes use `previous.contentFingerprint`
   * only (we don't retain the deleted text and honestly signalling "deleted"
   * is enough for Ariadne to reason about the change).
   */
  currentByMessageId: Map<string, RenderableMessage>
}

/**
 * Build the volatile "since last turn" section. Returns an empty string when
 * there is no drift so callers can conditionally include the whole block.
 */
export function renderDelta(input: DeltaRenderInput): string {
  const { diff, currentByMessageId } = input
  if (diff.appends.length === 0 && diff.edits.length === 0 && diff.deletes.length === 0) {
    return ""
  }

  const lines: string[] = ["## Since last turn"]

  if (diff.appends.length > 0) {
    lines.push("", "Appended messages:")
    for (const append of diff.appends) {
      const current = currentByMessageId.get(append.messageId)
      if (!current) continue
      lines.push(formatInlineMessage(current))
    }
  }

  if (diff.edits.length > 0) {
    lines.push("", "Edited messages (treat as authoritative over the main context body):")
    for (const edit of diff.edits) {
      const current = currentByMessageId.get(edit.current.messageId)
      if (!current) continue
      lines.push(
        `- [${edit.current.messageId}] now reads:`,
        `  ${current.contentMarkdown.replaceAll("\n", "\n  ")}`,
        `  (previous fingerprint ${edit.previous.contentFingerprint.slice(0, 12)})`
      )
    }
  }

  if (diff.deletes.length > 0) {
    lines.push("", "Deleted messages:")
    for (const del of diff.deletes) {
      lines.push(`- [${del.messageId}] deleted (previous fingerprint ${del.contentFingerprint.slice(0, 12)})`)
    }
  }

  return lines.join("\n")
}

export function buildSnapshot(inputs: SummaryInput[], tailMessageId: string | null): LastRenderedSnapshot {
  return {
    renderedAt: new Date().toISOString(),
    items: inputs,
    tailMessageId,
  }
}
