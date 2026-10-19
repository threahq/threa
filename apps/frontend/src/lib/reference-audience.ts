import type { JSONContent, ReferenceAudience, ReferenceAudienceInput } from "@threahq/types"
import { classifyDraftLink } from "@/lib/in-app-links"

export type ReferenceAudienceTarget = ReferenceAudienceInput extends infer T
  ? T extends unknown
    ? Omit<T, "streamIds">
    : never
  : never

export interface ComposerReference {
  kind: "share" | "link"
  streamId: string
  messageId: string | null
}

export interface SendWarning {
  tone: "reveal" | "unreachable"
  lead: ReferenceAudience
  exposedShareStreamIds: string[]
  exposedLinkStreamIds: string[]
  canShareInstead: boolean
}

export interface ComposerSendWarning {
  warning: SendWarning
  names: string[]
}

export interface AudienceQuestionCopy {
  desktop: string
  mobile: string
  alternative: { desktop: string; mobile: string } | null
  primary: string
}

function linkMarkReference(node: JSONContent, origin: string | null | undefined): ComposerReference | null {
  const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href
  if (typeof href !== "string") return null
  const link = classifyDraftLink(href, origin)
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

function nodeReference(
  node: JSONContent,
  targetStreamId: string | null,
  origin: string | null | undefined
): ComposerReference | null {
  const attrs = node.attrs ?? {}
  switch (node.type) {
    case "sharedMessage":
      return attrReference("share", attrs)
    case "quoteReply":
      return attrs.streamId === targetStreamId ? null : attrReference("share", attrs)
    case "inAppLink":
      return attrReference("link", attrs)
    case "text":
      return linkMarkReference(node, origin)
    default:
      return null
  }
}

export function collectComposerReferences(
  content: JSONContent,
  targetStreamId: string | null,
  origin?: string | null
): ComposerReference[] {
  const refs: ComposerReference[] = []
  const walk = (node: JSONContent) => {
    const ref = nodeReference(node, targetStreamId, origin)
    if (ref) refs.push(ref)
    node.content?.forEach(walk)
  }
  walk(content)
  return refs
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
  const exposedOf = (kind: ComposerReference["kind"]) =>
    referenceStreamIds(refs.filter((ref) => ref.kind === kind && byStreamId.has(ref.streamId)))
  const exposedShareStreamIds = exposedOf("share")
  const exposedLinkStreamIds = exposedOf("link")
  const tone = exposedShareStreamIds.length > 0 ? "reveal" : "unreachable"
  const leadIds = tone === "reveal" ? exposedShareStreamIds : exposedLinkStreamIds
  if (leadIds.length === 0) return null

  const lead = leadIds
    .map((id) => byStreamId.get(id)!)
    .reduce((best, audience) => (audience.count > best.count ? audience : best))
  const canShareInstead = refs.some(
    (ref) => ref.kind === "link" && ref.messageId !== null && byStreamId.has(ref.streamId)
  )
  return { tone, lead, exposedShareStreamIds, exposedLinkStreamIds, canShareInstead }
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

function desktopNames(count: number, names: string[]): string {
  if (names.length === 0) return count === 1 ? "1 person" : `${count} people`
  if (count <= names.length) return joinNames(names.slice(0, count))
  const shown = names.slice(0, 2)
  return `${shown.join(", ")} +${count - shown.length}`
}

function mobileShort(tone: SendWarning["tone"], count: number, names: string[]): string {
  if (count === 1 && names.length > 0) return names[0]
  const noun = count === 1 ? "person" : "people"
  return tone === "reveal" ? `${count} new ${noun}` : `${count} ${noun}`
}

export function audienceQuestionCopy(warning: SendWarning, names: string[]): AudienceQuestionCopy {
  const { count } = warning.lead
  const who = desktopNames(count, names)
  const short = mobileShort(warning.tone, count, names)
  if (warning.tone === "reveal") {
    return {
      desktop: `${who} will see this message`,
      mobile: `${short} ${count === 1 ? "sees" : "see"} it`,
      alternative: { desktop: "Use link", mobile: "Link" },
      primary: "Send",
    }
  }
  return {
    desktop: `${who} can't open this link`,
    mobile: `${short} can't open it`,
    alternative: warning.canShareInstead ? { desktop: "Share instead", mobile: "Share" } : null,
    primary: "Send anyway",
  }
}
