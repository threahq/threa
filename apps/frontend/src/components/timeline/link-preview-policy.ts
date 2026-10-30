import {
  DEFAULT_LINK_PREVIEW_OPEN_COUNT,
  isInAppLinkContentType,
  type LinkPreviewCategory,
  type LinkPreviewSummary,
  type UserPreferences,
} from "@threahq/types"

export function classifyLinkPreview(preview: LinkPreviewSummary): LinkPreviewCategory {
  if (preview.contentType === "image" || preview.contentType === "pdf" || preview.contentType === "video") {
    return preview.contentType
  }
  const type = preview.previewData?.type ?? preview.previewType
  if (type?.startsWith("github_")) return "github"
  if (type?.startsWith("linear_")) return "linear"
  if (type === "video") return "video"
  try {
    const host = new URL(preview.url).hostname.toLowerCase()
    if (host === "github.com" || host === "www.github.com") return "github"
    if (host === "linear.app" || host === "www.linear.app") return "linear"
  } catch {
    return "website"
  }
  return "website"
}

export function resolveLinkPreviewDefaults(
  previews: LinkPreviewSummary[],
  preferences: Partial<
    Pick<UserPreferences, "linkPreviewDefault" | "linkPreviewOpenCount" | "linkPreviewTypeOverrides">
  > | null,
  showAllInternal: boolean
): Array<{ preview: LinkPreviewSummary; defaultOpen: boolean }> {
  const globalLimit =
    preferences?.linkPreviewDefault === "collapsed"
      ? 0
      : (preferences?.linkPreviewOpenCount ?? DEFAULT_LINK_PREVIEW_OPEN_COUNT)
  const overrides = preferences?.linkPreviewTypeOverrides ?? {}
  const counts = new Map<string, number>()
  let internalCount = 0
  return previews.flatMap((preview) => {
    if (isInAppLinkContentType(preview.contentType)) {
      internalCount++
      return showAllInternal || internalCount <= 3 ? [{ preview, defaultOpen: true }] : []
    }
    const category = classifyLinkPreview(preview)
    const hasOverride = Object.hasOwn(overrides, category)
    const key = hasOverride ? category : "default"
    const limit = hasOverride ? overrides[category]! : globalLimit
    const count = counts.get(key) ?? 0
    counts.set(key, count + 1)
    return [{ preview, defaultOpen: limit === "all" || count < limit }]
  })
}
