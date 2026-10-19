import type { JSONContent } from "@threahq/types"

/**
 * Attrs a node view writes back once its display data resolves. They never
 * change what the content says or points at, so asks and consent ignore them.
 */
export const DISPLAY_STAMP_ATTRS = {
  sharedMessage: ["authorName", "authorId", "actorType"],
  inAppLink: ["name"],
  memoEmbed: ["title"],
} as const

export type DisplayStampedNode = keyof typeof DISPLAY_STAMP_ATTRS
export type DisplayStamp<T extends DisplayStampedNode> = Partial<
  Record<(typeof DISPLAY_STAMP_ATTRS)[T][number], string>
>

function stampedAttrsOf(type: unknown): readonly string[] | undefined {
  return typeof type === "string" && type in DISPLAY_STAMP_ATTRS
    ? DISPLAY_STAMP_ATTRS[type as DisplayStampedNode]
    : undefined
}

/** Equal for two contents that differ only in display stamps. */
export function contentSignature(content: JSONContent): string {
  return JSON.stringify(content, function (this: JSONContent, key: string, value: unknown) {
    const stamped = key === "attrs" ? stampedAttrsOf(this.type) : undefined
    if (!stamped || !value || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).filter(([name]) => !stamped.includes(name)))
  })
}

export function withoutDisplayStamps(content: JSONContent): JSONContent {
  return JSON.parse(contentSignature(content)) as JSONContent
}
