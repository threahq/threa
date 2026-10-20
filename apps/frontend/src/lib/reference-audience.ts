import type { JSONContent, ReferenceAudience } from "@threahq/types"
import { classifyDraftLink } from "@/lib/in-app-links"

export interface ComposerReference {
  kind: "share" | "link"
  streamId: string
  messageId: string | null
}

export type SendTone = "reveal" | "unreachable"

export interface SendWarning {
  tone: SendTone
  lead: ReferenceAudience
  /** Every source the draft exposes, by how: shares reveal, links are unreachable. One answer covers them all. */
  exposed: Record<SendTone, string[]>
  /** What the alternative converts: shares on reveal, message links on unreachable. Empty means no alternative. */
  convertibleStreamIds: string[]
}

export interface ComposerSendWarning {
  warning: SendWarning
  names: string[]
  /** The answer covers every ref in the draft, so the send may carry consent. */
  settled: boolean
  /** The destination the answer is about; consent never carries over to another one. */
  targetKey: string
}

export interface AudienceQuestionCopy {
  full: string
  short: string
  alternative: { full: string; short: string } | null
  primary: string
}

function linkMarkReference(node: JSONContent): ComposerReference | null {
  const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href
  if (typeof href !== "string") return null
  const link = classifyDraftLink(href)
  if (link?.kind === "stream") return { kind: "link", streamId: link.streamId, messageId: null }
  if (link?.kind === "message") return { kind: "link", streamId: link.streamId, messageId: link.messageId }
  return null
}

function stringAttr(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function attrReference(kind: ComposerReference["kind"], attrs: Record<string, unknown>): ComposerReference | null {
  const streamId = stringAttr(attrs.streamId)
  return streamId ? { kind, streamId, messageId: stringAttr(attrs.messageId) } : null
}

function nodeReference(node: JSONContent, targetStreamId: string | null): ComposerReference | null {
  const attrs = node.attrs ?? {}
  switch (node.type) {
    case "sharedMessage":
      return attrReference("share", attrs)
    case "quoteReply":
      return attrs.streamId === targetStreamId ? null : attrReference("share", attrs)
    case "inAppLink":
      return attrReference("link", attrs)
    case "text":
      return linkMarkReference(node)
    default:
      return null
  }
}

export function collectComposerReferences(content: JSONContent, targetStreamId: string | null): ComposerReference[] {
  const refs: ComposerReference[] = []
  const walk = (node: JSONContent) => {
    const ref = nodeReference(node, targetStreamId)
    if (ref) refs.push(ref)
    node.content?.forEach(walk)
  }
  walk(content)
  return refs
}

export function referenceKeyOf({ kind, streamId, messageId }: ComposerReference): string {
  return `${kind}:${streamId}:${messageId ?? ""}`
}

export function referenceStreamIds(refs: ComposerReference[]): string[] {
  return [...new Set(refs.map((ref) => ref.streamId))].sort()
}

/** Source streams whose readers differ from the destination's, keyed by stream id. */
export function exposingAudiences(audiences: ReferenceAudience[]): Map<string, ReferenceAudience> {
  return new Map(audiences.filter((a) => a.count > 0).map((a) => [a.streamId, a]))
}

export function resolveSendWarning(
  refs: ComposerReference[],
  byStreamId: ReadonlyMap<string, ReferenceAudience>
): SendWarning | null {
  const exposedWhere = (include: (ref: ComposerReference) => boolean) =>
    referenceStreamIds(refs.filter((ref) => include(ref) && byStreamId.has(ref.streamId)))
  const exposed = {
    reveal: exposedWhere((ref) => ref.kind === "share"),
    unreachable: exposedWhere((ref) => ref.kind === "link"),
  }
  const tone: SendTone = exposed.reveal.length > 0 ? "reveal" : "unreachable"
  if (exposed[tone].length === 0) return null

  const lead = exposed[tone]
    .map((id) => byStreamId.get(id)!)
    .reduce((best, audience) => (audience.count > best.count ? audience : best))
  const convertibleStreamIds =
    tone === "reveal" ? exposed.reveal : exposedWhere((ref) => ref.kind === "link" && ref.messageId !== null)
  return { tone, lead, exposed, convertibleStreamIds }
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

function fullAudience(count: number, names: string[]): string {
  if (names.length === 0) return count === 1 ? "1 person" : `${count} people`
  if (count <= names.length) return joinNames(names.slice(0, count))
  const shown = names.slice(0, 2)
  return `${shown.join(", ")} +${count - shown.length}`
}

function shortAudience(tone: SendTone, count: number, names: string[]): string {
  if (count === 1 && names.length > 0) return names[0]
  const noun = count === 1 ? "person" : "people"
  return tone === "reveal" ? `${count} new ${noun}` : `${count} ${noun}`
}

export type SendVerb = "Send" | "Schedule" | "Save"

export function audienceQuestionCopy(
  warning: SendWarning,
  names: string[],
  verb: SendVerb = "Send"
): AudienceQuestionCopy {
  const { count } = warning.lead
  const who = fullAudience(count, names)
  const short = shortAudience(warning.tone, count, names)
  if (warning.tone === "reveal") {
    return {
      full: `${who} will see this message`,
      short: `${short} ${count === 1 ? "sees" : "see"} it`,
      alternative: { full: "Use link", short: "Link" },
      primary: verb,
    }
  }
  return {
    full: `${who} can't open this link`,
    short: `${short} can't open it`,
    alternative: warning.convertibleStreamIds.length > 0 ? { full: "Share instead", short: "Share" } : null,
    primary: `${verb} anyway`,
  }
}
