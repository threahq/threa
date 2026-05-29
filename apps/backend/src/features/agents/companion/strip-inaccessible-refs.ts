import type { Pool } from "pg"
import { serializeToMarkdown } from "@threa/prosemirror"
import { AttachmentSafetyStatuses, type JSONContent } from "@threa/types"
import { MessageRepository } from "../../messaging"
import { AttachmentRepository, AttachmentReferenceRepository } from "../../attachments"
import { MemoRepository } from "../../memos"
import { logger } from "../../../lib/logger"

/**
 * Reasons a structural reference (share, quote, attachment) was stripped
 * from an agent's outgoing message. Logged for observability — we never
 * surface them to the model in this turn (no auto-retry today), but they
 * help diagnose access drift between context-formatting and write-time
 * validation.
 */
export type DroppedRefReason =
  | "message-not-found"
  | "stream-mismatch"
  | "stream-out-of-scope"
  | "attachment-not-found"
  | "attachment-out-of-scope"
  | "attachment-cross-workspace"
  | "attachment-not-clean"
  | "memo-not-found"
  | "memo-not-active"

export interface DroppedRef {
  type: "sharedMessage" | "quoteReply" | "attachmentReference" | "memoEmbed"
  reason: DroppedRefReason
  /** Identifier(s) the agent tried to use; logged only — not echoed to UI. */
  ids: Record<string, string>
}

export interface StripResult {
  contentJson: JSONContent
  contentMarkdown: string
  dropped: DroppedRef[]
}

export interface StripParams {
  pool: Pool
  workspaceId: string
  /** The stream the agent is posting INTO (used to skip same-stream quote-reply validation). */
  targetStreamId: string
  /** Agent's `AgentAccessSpec` reach. Refs to streams outside this set are stripped. */
  accessibleStreamIds: string[]
  contentJson: JSONContent
}

/**
 * Pre-validate `sharedMessage` / `quoteReply` / `attachmentReference` /
 * `memoEmbed` nodes in an agent's outgoing message and drop the ones that
 * shouldn't ship. Returns the cleaned content tree + matching markdown.
 *
 * Why: event-service rejects the entire message when a share/quote/attachment
 * reference fails the access gate (intentional — strict for users,
 * defense-in-depth here). For agent-authored messages we'd rather lose the bad
 * pointer than the whole response, since the prose around it is usually still
 * useful.
 *
 * The share/quote/attachment validation mirrors event-service step 1
 * (attachments) and step 7 (cross-stream shares/quotes) exactly: same
 * access-scope semantics (`accessibleStreamIds` from `AgentAccessSpec`), same
 * workspace boundary (cross-workspace messages collapse into "not found" per
 * INV-8), same reference-projection fallback for attachments. Refs that survive
 * here will pass event-service.
 *
 * `memoEmbed` has no write-time gate (event-service silently passes it, same as
 * for users), so this isn't about avoiding rejection — it's about not posting a
 * card for a memo the model invented. LLMs hallucinate ids, so we drop memo
 * pointers that don't resolve to an active memo in the workspace (INV-8).
 * Per-recipient visibility is still enforced at render time by the memo-detail
 * endpoint, so we deliberately don't re-check stream reach here.
 *
 * Same-stream `quoteReply` is left alone — it's purely presentational, has
 * no DB write path, and writing a same-stream quote with a stale id is
 * already a graceful UX failure at click time.
 */
export async function stripInaccessibleAgentRefs(params: StripParams): Promise<StripResult> {
  const { pool, workspaceId, targetStreamId, contentJson } = params
  const accessibleSet = new Set(params.accessibleStreamIds)

  // Pass 1: collect candidate ids so we batch the DB lookups.
  const messageIdsToCheck = new Set<string>()
  const attachmentIdsToCheck = new Set<string>()
  const memoIdsToCheck = new Set<string>()
  walk(contentJson, (node) => {
    if (node.type === "sharedMessage") {
      const id = (node.attrs?.messageId as string | undefined) ?? null
      if (id) messageIdsToCheck.add(id)
    } else if (node.type === "quoteReply") {
      const id = (node.attrs?.messageId as string | undefined) ?? null
      const streamId = (node.attrs?.streamId as string | undefined) ?? null
      if (id && streamId && streamId !== targetStreamId) {
        // Only validate cross-stream quotes (same path event-service walks).
        messageIdsToCheck.add(id)
      }
    } else if (node.type === "attachmentReference") {
      const id = (node.attrs?.id as string | undefined) ?? null
      if (id) attachmentIdsToCheck.add(id)
    } else if (node.type === "memoEmbed") {
      const id = (node.attrs?.memoId as string | undefined) ?? null
      if (id) memoIdsToCheck.add(id)
    }
  })

  const messageMap =
    messageIdsToCheck.size > 0
      ? await MessageRepository.findByIdsInWorkspace(pool, workspaceId, [...messageIdsToCheck])
      : new Map()

  const memoMap =
    memoIdsToCheck.size > 0
      ? await MemoRepository.findByIdsInWorkspace(pool, workspaceId, [...memoIdsToCheck])
      : new Map()

  const attachments =
    attachmentIdsToCheck.size > 0 ? await AttachmentRepository.findByIds(pool, [...attachmentIdsToCheck]) : []
  const attachmentMap = new Map(attachments.map((a) => [a.id, a]))

  // Per-attachment access decision, mirroring `AttachmentService.getAccessible`
  // plus event-service step 1's safety gate. The two checks compose to:
  //   1. Workspace boundary
  //   2. Safety: malware-scan must be CLEAN (event-service rejects otherwise)
  //   3. Reachability: direct stream membership in scope, OR any referencing
  //      stream in scope (so attachments visible via inline references in
  //      scope still pass even when the upload stream isn't directly reachable)
  //
  // Step 3's reference-projection lookups are batched via Promise.all so
  // multi-attachment messages don't pay sequential round-trip latency.
  const attachmentDecisions: Array<{
    attachId: string
    decision: "ok" | "not-found" | "cross-workspace" | "not-clean" | "out-of-scope"
  }> = []
  await Promise.all(
    [...attachmentIdsToCheck].map(async (attachId) => {
      const a = attachmentMap.get(attachId)
      if (!a) {
        attachmentDecisions.push({ attachId, decision: "not-found" })
        return
      }
      if (a.workspaceId !== workspaceId) {
        attachmentDecisions.push({ attachId, decision: "cross-workspace" })
        return
      }
      if (a.safetyStatus !== AttachmentSafetyStatuses.CLEAN) {
        attachmentDecisions.push({ attachId, decision: "not-clean" })
        return
      }
      if (a.streamId && accessibleSet.has(a.streamId)) {
        attachmentDecisions.push({ attachId, decision: "ok" })
        return
      }
      const refStreamIds = await AttachmentReferenceRepository.findReferencingStreamIds(pool, workspaceId, attachId)
      attachmentDecisions.push({
        attachId,
        decision: refStreamIds.some((s) => accessibleSet.has(s)) ? "ok" : "out-of-scope",
      })
    })
  )
  const attachmentDecisionMap = new Map(attachmentDecisions.map((d) => [d.attachId, d.decision]))

  // Pass 2: walk and rewrite, recording drops.
  const dropped: DroppedRef[] = []
  const cleanedJson = rewrite(contentJson, {
    onSharedMessage: (node) => {
      const messageId = node.attrs?.messageId as string | undefined
      const streamId = node.attrs?.streamId as string | undefined
      if (!messageId || !streamId) {
        dropped.push({ type: "sharedMessage", reason: "message-not-found", ids: { messageId: messageId ?? "" } })
        return null
      }
      const msg = messageMap.get(messageId)
      if (!msg) {
        // INV-8: cross-workspace messages collapse here; in-workspace deny
        // can also surface as "not found" depending on upstream pattern.
        dropped.push({ type: "sharedMessage", reason: "message-not-found", ids: { messageId, streamId } })
        return null
      }
      if (msg.streamId !== streamId) {
        dropped.push({ type: "sharedMessage", reason: "stream-mismatch", ids: { messageId, streamId } })
        return null
      }
      if (!accessibleSet.has(streamId)) {
        dropped.push({ type: "sharedMessage", reason: "stream-out-of-scope", ids: { messageId, streamId } })
        return null
      }
      return node
    },
    onQuoteReply: (node) => {
      const messageId = node.attrs?.messageId as string | undefined
      const streamId = node.attrs?.streamId as string | undefined
      // Same-stream: not validated against the share path; pass through.
      if (!streamId || streamId === targetStreamId) return node
      if (!messageId) {
        dropped.push({ type: "quoteReply", reason: "message-not-found", ids: { messageId: messageId ?? "" } })
        return null
      }
      const msg = messageMap.get(messageId)
      if (!msg) {
        dropped.push({ type: "quoteReply", reason: "message-not-found", ids: { messageId, streamId } })
        return null
      }
      if (msg.streamId !== streamId) {
        dropped.push({ type: "quoteReply", reason: "stream-mismatch", ids: { messageId, streamId } })
        return null
      }
      if (!accessibleSet.has(streamId)) {
        dropped.push({ type: "quoteReply", reason: "stream-out-of-scope", ids: { messageId, streamId } })
        return null
      }
      return node
    },
    onAttachmentReference: (node) => {
      const id = node.attrs?.id as string | undefined
      if (!id) {
        dropped.push({ type: "attachmentReference", reason: "attachment-not-found", ids: { id: "" } })
        return null
      }
      const decision = attachmentDecisionMap.get(id) ?? "not-found"
      switch (decision) {
        case "ok":
          return node
        case "not-found":
          dropped.push({ type: "attachmentReference", reason: "attachment-not-found", ids: { id } })
          return null
        case "cross-workspace":
          dropped.push({ type: "attachmentReference", reason: "attachment-cross-workspace", ids: { id } })
          return null
        case "not-clean":
          // Mirrors event-service step 1's malware-scan gate. Refs surviving
          // strip without this would still throw at write time.
          dropped.push({ type: "attachmentReference", reason: "attachment-not-clean", ids: { id } })
          return null
        case "out-of-scope":
          dropped.push({ type: "attachmentReference", reason: "attachment-out-of-scope", ids: { id } })
          return null
      }
    },
    onMemoEmbed: (node) => {
      const memoId = node.attrs?.memoId as string | undefined
      if (!memoId) {
        dropped.push({ type: "memoEmbed", reason: "memo-not-found", ids: { memoId: "" } })
        return null
      }
      const memo = memoMap.get(memoId)
      if (!memo) {
        // INV-8: cross-workspace memos collapse here into "not found".
        dropped.push({ type: "memoEmbed", reason: "memo-not-found", ids: { memoId } })
        return null
      }
      if (memo.status !== "active") {
        dropped.push({ type: "memoEmbed", reason: "memo-not-active", ids: { memoId } })
        return null
      }
      return node
    },
  })

  if (dropped.length > 0) {
    logger.warn(
      { workspaceId, targetStreamId, droppedCount: dropped.length, dropped },
      "Stripped inaccessible refs from agent message"
    )
  }

  const contentMarkdown = serializeToMarkdown(cleanedJson)

  return { contentJson: cleanedJson, contentMarkdown, dropped }
}

function walk(node: JSONContent, visit: (node: JSONContent) => void): void {
  visit(node)
  if (node.content) {
    for (const child of node.content) {
      walk(child, visit)
    }
  }
}

interface RewriteHandlers {
  onSharedMessage: (node: JSONContent) => JSONContent | null
  onQuoteReply: (node: JSONContent) => JSONContent | null
  onAttachmentReference: (node: JSONContent) => JSONContent | null
  onMemoEmbed: (node: JSONContent) => JSONContent | null
}

/**
 * Recursively rewrite a content tree, replacing each handler's matched node
 * with the handler's return value. Returning `null` removes the node from
 * its parent's `content` array.
 */
function rewrite(node: JSONContent, handlers: RewriteHandlers): JSONContent {
  if (node.type === "sharedMessage") {
    const replaced = handlers.onSharedMessage(node)
    return replaced ?? { type: "_dropped" }
  }
  if (node.type === "quoteReply") {
    const replaced = handlers.onQuoteReply(node)
    return replaced ?? { type: "_dropped" }
  }
  if (node.type === "attachmentReference") {
    const replaced = handlers.onAttachmentReference(node)
    return replaced ?? { type: "_dropped" }
  }
  if (node.type === "memoEmbed") {
    const replaced = handlers.onMemoEmbed(node)
    return replaced ?? { type: "_dropped" }
  }
  if (!node.content) return node
  const newContent: JSONContent[] = []
  for (const child of node.content) {
    const rewritten = rewrite(child, handlers)
    if (rewritten.type !== "_dropped") {
      newContent.push(rewritten)
    }
  }
  return { ...node, content: newContent }
}
