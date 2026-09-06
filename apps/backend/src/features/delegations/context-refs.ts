import type { Pool } from "pg"
import { parseMemoHref, parseSharedMessageHref } from "@threahq/prosemirror"
import { AttachmentSafetyStatuses } from "@threahq/types"
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

/** A parsed ref, or `null` when the string matches none of the supported schemes. */
type ParsedRef =
  | { kind: "message"; streamId: string; messageId: string }
  | { kind: "memo"; memoId: string }
  | { kind: "attachment"; attachmentId: string }

function parseRef(ref: string): ParsedRef | null {
  const shared = parseSharedMessageHref(ref)
  if (shared) return { kind: "message", streamId: shared.streamId, messageId: shared.messageId }
  const memo = parseMemoHref(ref)
  if (memo) return { kind: "memo", memoId: memo.memoId }
  const attachmentId = parseAttachmentRef(ref)
  if (attachmentId) return { kind: "attachment", attachmentId }
  return null
}

/**
 * Validate a delegation's pointer URLs (`shared-message:` / `memo:` /
 * `attachment:`) against the invoking user's access before they are persisted
 * onto the card. Mirrors `stripInaccessibleAgentRefs` (companion write path)
 * decision-for-decision AND shape-for-shape: a parse pass collects ids, one
 * batched lookup per kind resolves them, then each ref is classified — never
 * a round trip per ref. The input form differs (pointer-URL strings, not a
 * content tree), which is why this isn't the same function.
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

  // Pass 1: parse and collect candidate ids so lookups batch per kind.
  const parsed = refs.map((ref) => ({ ref, parsed: parseRef(ref) }))
  const messageIds = new Set<string>()
  const memoIds = new Set<string>()
  const attachmentIds = new Set<string>()
  for (const { parsed: p } of parsed) {
    if (p?.kind === "message") messageIds.add(p.messageId)
    else if (p?.kind === "memo") memoIds.add(p.memoId)
    else if (p?.kind === "attachment") attachmentIds.add(p.attachmentId)
  }

  const [messageMap, memoMap, attachments] = await Promise.all([
    messageIds.size > 0
      ? MessageRepository.findByIdsInWorkspace(pool, workspaceId, [...messageIds])
      : new Map<string, { streamId: string }>(),
    memoIds.size > 0
      ? MemoRepository.findByIdsInWorkspace(pool, workspaceId, [...memoIds])
      : new Map<string, { status: string }>(),
    attachmentIds.size > 0 ? AttachmentRepository.findByIds(pool, [...attachmentIds]) : [],
  ])
  const attachmentMap = new Map(attachments.map((a) => [a.id, a]))

  // Attachment reachability: direct stream in scope, else any referencing
  // stream in scope — the reference-projection fallback, batched like the
  // strip path's Promise.all.
  const attachmentReachable = new Map<string, boolean>()
  await Promise.all(
    [...attachmentIds].map(async (id) => {
      const attachment = attachmentMap.get(id)
      if (!attachment || attachment.workspaceId !== workspaceId) return
      if (attachment.safetyStatus !== AttachmentSafetyStatuses.CLEAN) return
      if (attachment.streamId && accessibleSet.has(attachment.streamId)) {
        attachmentReachable.set(id, true)
        return
      }
      const refStreamIds = await AttachmentReferenceRepository.findReferencingStreamIds(pool, workspaceId, id)
      attachmentReachable.set(
        id,
        refStreamIds.some((s) => accessibleSet.has(s))
      )
    })
  )

  // Pass 2: classify each ref in input order.
  const accepted: string[] = []
  const dropped: DroppedContextRef[] = []
  for (const { ref, parsed: p } of parsed) {
    const reason = classifyParsedRef(p, {
      workspaceId,
      accessibleSet,
      messageMap,
      memoMap,
      attachmentMap,
      attachmentReachable,
    })
    if (reason === null) accepted.push(ref)
    else dropped.push({ ref, reason })
  }

  if (dropped.length > 0) {
    logger.warn({ workspaceId, dropped }, "Dropped inaccessible context refs from delegation")
  }
  return { accepted, dropped }
}

function classifyParsedRef(
  parsed: ParsedRef | null,
  lookups: {
    workspaceId: string
    accessibleSet: Set<string>
    messageMap: Map<string, { streamId: string }>
    memoMap: Map<string, { status: string }>
    attachmentMap: Map<string, { workspaceId: string; safetyStatus: string; streamId: string | null }>
    attachmentReachable: Map<string, boolean>
  }
): DroppedContextRefReason | null {
  if (!parsed) return "unsupported-scheme"

  if (parsed.kind === "message") {
    const message = lookups.messageMap.get(parsed.messageId)
    // Cross-workspace collapses into "not found" (INV-8) — the lookup is workspace-scoped.
    if (!message) return "message-not-found"
    if (message.streamId !== parsed.streamId) return "stream-mismatch"
    if (!lookups.accessibleSet.has(parsed.streamId)) return "stream-out-of-scope"
    return null
  }

  if (parsed.kind === "memo") {
    const memo = lookups.memoMap.get(parsed.memoId)
    if (!memo) return "memo-not-found"
    if (memo.status !== "active") return "memo-not-active"
    return null
  }

  const attachment = lookups.attachmentMap.get(parsed.attachmentId)
  if (!attachment || attachment.workspaceId !== lookups.workspaceId) return "attachment-not-found"
  if (attachment.safetyStatus !== AttachmentSafetyStatuses.CLEAN) return "attachment-not-clean"
  return lookups.attachmentReachable.get(parsed.attachmentId) ? null : "attachment-out-of-scope"
}

/** `attachment:<id>` — single `[\w-]+` segment, same strictness as `parseMemoHref`. */
function parseAttachmentRef(ref: string): string | null {
  if (!ref.startsWith("attachment:")) return null
  const id = ref.slice("attachment:".length)
  return /^[\w-]+$/.test(id) ? id : null
}
