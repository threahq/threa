import type { Pool } from "pg"
import { parseMemoHref, parseSharedMessageHref } from "@threa/prosemirror"
import { AttachmentSafetyStatuses } from "@threa/types"
import { MessageRepository } from "../messaging"
import { AttachmentRepository, AttachmentReferenceRepository } from "../attachments"
import { MemoRepository } from "../memos"
import { logger } from "../../lib/logger"

export type DroppedContextRefReason =
  | "unsupported-scheme"
  | "message-not-found"
  | "stream-mismatch"
  | "stream-out-of-scope"
  | "attachment-not-found"
  | "attachment-not-clean"
  | "attachment-out-of-scope"
  | "memo-not-found"
  | "memo-not-active"

export interface DroppedContextRef {
  ref: string
  reason: DroppedContextRefReason
}

export interface ValidateContextRefsParams {
  pool: Pool
  workspaceId: string
  /**
   * The invoking USER's reach (their `AgentAccessSpec` resolved to stream ids).
   * The delegation ruling (#1118, roadmap 5.1): the hand-off may carry only
   * what the requesting user can see — the user owns the local agent and its
   * credentials, so the persona's own scope never widens the brief.
   */
  accessibleStreamIds: string[]
  refs: string[]
}

export interface ValidateContextRefsResult {
  accepted: string[]
  dropped: DroppedContextRef[]
}

/**
 * Validate a delegation's pointer URLs (`shared-message:` / `memo:` /
 * `attachment:`) against the invoking user's access before they are persisted
 * onto the card. Mirrors the decisions of `stripInaccessibleAgentRefs`
 * (companion write path) ref-kind by ref-kind, but takes the pointer-URL wire
 * form directly — a delegation stores refs as strings, not a content tree.
 *
 * LLMs hallucinate ids, so unresolvable refs are dropped (and reported to the
 * tool so the model can correct), never persisted: a card whose "Copy prompt"
 * includes dead or inaccessible pointers hands the local agent garbage.
 */
export async function validateDelegationContextRefs(
  params: ValidateContextRefsParams
): Promise<ValidateContextRefsResult> {
  const { pool, workspaceId, refs } = params
  const accessibleSet = new Set(params.accessibleStreamIds)

  const accepted: string[] = []
  const dropped: DroppedContextRef[] = []

  for (const ref of refs) {
    const reason = await classifyRef(pool, workspaceId, accessibleSet, ref)
    if (reason === null) accepted.push(ref)
    else dropped.push({ ref, reason })
  }

  if (dropped.length > 0) {
    logger.warn({ workspaceId, dropped }, "Dropped inaccessible context refs from delegation")
  }
  return { accepted, dropped }
}

async function classifyRef(
  pool: Pool,
  workspaceId: string,
  accessibleSet: Set<string>,
  ref: string
): Promise<DroppedContextRefReason | null> {
  const shared = parseSharedMessageHref(ref)
  if (shared) {
    const messages = await MessageRepository.findByIdsInWorkspace(pool, workspaceId, [shared.messageId])
    const message = messages.get(shared.messageId)
    if (!message) return "message-not-found"
    if (message.streamId !== shared.streamId) return "stream-mismatch"
    if (!accessibleSet.has(shared.streamId)) return "stream-out-of-scope"
    return null
  }

  const memo = parseMemoHref(ref)
  if (memo) {
    const memos = await MemoRepository.findByIdsInWorkspace(pool, workspaceId, [memo.memoId])
    const row = memos.get(memo.memoId)
    if (!row) return "memo-not-found"
    if (row.status !== "active") return "memo-not-active"
    return null
  }

  const attachmentId = parseAttachmentRef(ref)
  if (attachmentId) {
    const [attachment] = await AttachmentRepository.findByIds(pool, [attachmentId])
    // Cross-workspace collapses into "not found" (INV-8).
    if (!attachment || attachment.workspaceId !== workspaceId) return "attachment-not-found"
    if (attachment.safetyStatus !== AttachmentSafetyStatuses.CLEAN) return "attachment-not-clean"
    if (attachment.streamId && accessibleSet.has(attachment.streamId)) return null
    const refStreamIds = await AttachmentReferenceRepository.findReferencingStreamIds(pool, workspaceId, attachmentId)
    return refStreamIds.some((s) => accessibleSet.has(s)) ? null : "attachment-out-of-scope"
  }

  return "unsupported-scheme"
}

/** `attachment:<id>` — single `[\w-]+` segment, same strictness as `parseMemoHref`. */
function parseAttachmentRef(ref: string): string | null {
  if (!ref.startsWith("attachment:")) return null
  const id = ref.slice("attachment:".length)
  return /^[\w-]+$/.test(id) ? id : null
}
