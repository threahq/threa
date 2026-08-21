import { isEmptySlice, isRangeValid, normalizeRange, parseMarkdown, resolveSelectionRange } from "@threa/prosemirror"
import { MessageReferenceErrorCodes, type ContentRange, type JSONContent } from "@threa/types"

import type { Querier } from "../../../db"
import { HttpError } from "../../../lib/errors"
import { resolveActorNames } from "../../agents"
import { MessageRepository, type Message } from "../repository"
import { MessageVersionRepository, messageVersionKey, type MessageVersionKey } from "../version-repository"

import { sliceReferenceContent } from "./slice"

const REFERENCE_NODE_TYPES = new Set(["quoteReply", "sharedMessage"])

interface ReferenceAttrs {
  messageId?: unknown
  streamId?: unknown
  authorName?: unknown
  authorId?: unknown
  actorType?: unknown
  snippet?: unknown
  version?: unknown
  range?: unknown
}

interface ReferenceNode {
  node: JSONContent
  attrs: ReferenceAttrs
  messageId: string
  isQuote: boolean
}

export interface ResolveMessageReferencesParams {
  workspaceId: string
  contentJson: JSONContent
}

export interface ResolveMessageReferencesResult {
  contentJson: JSONContent
  changed: boolean
}

function referenceError(code: string, message: string): HttpError {
  return new HttpError(message, { status: 400, code })
}

function collectReferenceNodes(root: JSONContent): ReferenceNode[] {
  const found: ReferenceNode[] = []
  const walk = (node: JSONContent): void => {
    if (node.type && REFERENCE_NODE_TYPES.has(node.type)) {
      const attrs = (node.attrs ?? {}) as ReferenceAttrs
      if (typeof attrs.messageId === "string" && attrs.messageId.length > 0) {
        found.push({ node, attrs, messageId: attrs.messageId, isQuote: node.type === "quoteReply" })
      }
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(root)
  return found
}

/** Text a reader would see, with atoms reduced to a separator. */
function docToPlainText(node: JSONContent): string {
  const parts: string[] = []
  const walk = (n: JSONContent): void => {
    if (n.type === "text") {
      parts.push(n.text ?? "")
      return
    }
    if (n.content) {
      for (const child of n.content) walk(child)
    }
    parts.push(" ")
  }
  walk(node)
  return parts.join("")
}

function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\u00A0\u200B-\u200D\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function readVersion(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw referenceError(MessageReferenceErrorCodes.VERSION_NOT_FOUND, "Referenced message version does not exist")
  }
  return raw
}

function readRange(raw: unknown): ContentRange | null {
  if (raw === null || raw === undefined) return null
  const candidate = raw as { from?: unknown; to?: unknown }
  if (typeof candidate.from !== "number" || typeof candidate.to !== "number") {
    throw referenceError(MessageReferenceErrorCodes.RANGE_INVALID, "Reference range is not a valid content range")
  }
  return { from: candidate.from, to: candidate.to }
}

function sameRange(a: ContentRange | null, b: ContentRange | null): boolean {
  if (a === null || b === null) return a === b
  return a.from === b.from && a.to === b.to
}

/**
 * The span of `pinnedDoc` a legacy (rangeless) quote is talking about, located
 * from the snippet the client stored. `null` means the whole message.
 */
function locateSnippetRange(pinnedDoc: JSONContent, snippet: unknown): ContentRange | null {
  if (typeof snippet !== "string") return null
  const wanted = normalizeText(docToPlainText(parseMarkdown(snippet)))
  if (wanted.length === 0) return null
  if (wanted === normalizeText(docToPlainText(pinnedDoc))) return null

  const located = resolveSelectionRange(pinnedDoc, { text: wanted })
  if (!located) {
    throw referenceError(MessageReferenceErrorCodes.RANGE_NOT_FOUND, "Quoted text is not in the referenced message")
  }
  return normalizeRange(pinnedDoc, located)
}

function validateRange(pinnedDoc: JSONContent, raw: ContentRange): ContentRange | null {
  if (!isRangeValid(pinnedDoc, raw)) {
    throw referenceError(MessageReferenceErrorCodes.RANGE_INVALID, "Reference range is outside the referenced message")
  }
  const normalized = normalizeRange(pinnedDoc, raw)
  if (normalized && isEmptySlice(sliceReferenceContent(pinnedDoc, normalized).contentJson)) {
    throw referenceError(MessageReferenceErrorCodes.RANGE_INVALID, "Reference range covers no content")
  }
  return normalized
}

/**
 * Pin every quote and share node in `contentJson` to a source revision and a
 * span of it, and re-derive each quote's snippet from that span — the server is
 * the only writer of a quote body, so a forged or stale snippet is overwritten
 * rather than trusted.
 *
 * Runs on create and on edit, right after mention resolution and before the
 * version snapshot, the event, the projections and the outbox, so everything
 * downstream reads one already-pinned body. Idempotent: re-running over its own
 * output reports `changed: false` and produces identical JSON.
 *
 * Soft-deleted sources still resolve — a message that pinned a source keeps
 * resolving after the source is deleted, and the hydration layer decides what a
 * viewer sees. Cross-stream ACCESS is not decided here: `ShareService` still
 * owns it and still runs after this.
 */
export async function resolveMessageReferences(
  db: Querier,
  params: ResolveMessageReferencesParams
): Promise<ResolveMessageReferencesResult> {
  const scanned = collectReferenceNodes(params.contentJson)
  if (scanned.length === 0) return { contentJson: params.contentJson, changed: false }

  const contentJson = structuredClone(params.contentJson)
  const references = collectReferenceNodes(contentJson)

  const sourcesById = await MessageRepository.findByIdsInWorkspace(db, params.workspaceId, [
    ...new Set(references.map((ref) => ref.messageId)),
  ])

  const versions = new Map<ReferenceNode, { source: Message; version: number }>()
  const versionKeys: MessageVersionKey[] = []
  for (const ref of references) {
    const source = sourcesById.get(ref.messageId)
    if (!source) {
      throw referenceError(MessageReferenceErrorCodes.SOURCE_NOT_FOUND, "Referenced message not found")
    }
    const requested = readVersion(ref.attrs.version)
    const version = requested ?? source.revision
    if (version > source.revision) {
      throw referenceError(MessageReferenceErrorCodes.VERSION_NOT_FOUND, "Referenced message version does not exist")
    }
    versions.set(ref, { source, version })
    if (version !== source.revision) versionKeys.push({ messageId: ref.messageId, versionNumber: version })
  }

  const versionRows = await MessageVersionRepository.findByMessageVersions(db, versionKeys)

  const quoteAuthorIds = new Set<string>()
  for (const ref of references) {
    if (ref.isQuote) quoteAuthorIds.add(versions.get(ref)!.source.authorId)
  }
  const authorNames = await resolveActorNames(db, params.workspaceId, quoteAuthorIds)

  let changed = false
  for (const ref of references) {
    const { source, version } = versions.get(ref)!
    const pinnedDoc =
      version === source.revision
        ? source.contentJson
        : versionRows.get(messageVersionKey(ref.messageId, version))?.contentJson
    if (!pinnedDoc) {
      throw referenceError(MessageReferenceErrorCodes.VERSION_NOT_FOUND, "Referenced message version does not exist")
    }

    const requestedRange = readRange(ref.attrs.range)
    let range: ContentRange | null = null
    if (requestedRange) range = validateRange(pinnedDoc, requestedRange)
    else if (ref.isQuote) range = locateSnippetRange(pinnedDoc, ref.attrs.snippet)

    if (ref.isQuote) {
      // A bot-authored source has no name in `resolveActorNames` (users and
      // personas only), so the client's cached label is the only attribution
      // available — keeping it beats regressing every bot quote to "Unknown".
      const authorName =
        authorNames.get(source.authorId) ??
        (typeof ref.attrs.authorName === "string" && ref.attrs.authorName.length > 0 ? ref.attrs.authorName : "Unknown")
      const next = {
        messageId: source.id,
        streamId: source.streamId,
        authorName,
        authorId: source.authorId,
        actorType: source.authorType,
        snippet: sliceReferenceContent(pinnedDoc, range).contentMarkdown,
        version,
        range,
      }
      if (
        Object.keys(ref.attrs).length !== Object.keys(next).length ||
        ref.attrs.messageId !== next.messageId ||
        ref.attrs.streamId !== next.streamId ||
        ref.attrs.authorName !== next.authorName ||
        ref.attrs.authorId !== next.authorId ||
        ref.attrs.actorType !== next.actorType ||
        ref.attrs.snippet !== next.snippet ||
        readVersion(ref.attrs.version) !== next.version ||
        !sameRange(readRange(ref.attrs.range), next.range)
      ) {
        ref.node.attrs = next
        changed = true
      }
      continue
    }

    if (readVersion(ref.attrs.version) !== version || !sameRange(readRange(ref.attrs.range), range)) {
      ref.node.attrs = { ...ref.attrs, version, range }
      changed = true
    }
  }

  return changed ? { contentJson, changed } : { contentJson: params.contentJson, changed: false }
}
