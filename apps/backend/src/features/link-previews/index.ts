export { LinkPreviewRepository } from "./repository"
export type { LinkPreview, InsertLinkPreviewParams, UpdateLinkPreviewParams, MessageLinkPreview } from "./repository"

export { LinkPreviewService, toLinkPreviewSummary } from "./service"
export type { LinkPreviewServiceDeps } from "./service"

export { createLinkPreviewHandlers } from "./handlers"

export { createLinkPreviewWorker } from "./worker"

export { LinkPreviewOutboxHandler } from "./outbox-handler"

export { extractUrls, normalizeUrl, detectContentType, isBlockedUrl, parseInAppLink, parseGitHubUrl } from "./url-utils"
export type { InAppLinkRef, GitHubUrlMatch } from "./url-utils"

export { refreshLinkPreview, findGithubPreviewMatches, DEFAULT_REFRESH_DEBOUNCE_MS } from "./refresh"
export type { RefreshLinkPreviewDeps, RefreshLinkPreviewResult } from "./refresh"

export {
  createLinkPreviewVisibleRefreshWorker,
  enqueueVisiblePreviewRefreshes,
  visibleRefreshQueueId,
  VISIBLE_REFRESH_DEBOUNCE_MS,
  VISIBLE_REFRESH_MAX_IDS,
  VISIBLE_REPORT_MIN_INTERVAL_MS,
} from "./visible-refresh"

export { MAX_PREVIEWS_PER_MESSAGE, getAppOrigins } from "./config"

export {
  awaitLinkPreviewProcessing,
  enrichMessagesWithLinkPreviews,
  enrichMessagesWithLinkPreviewMap,
  renderLinkPreviewContext,
  DEFAULT_LINK_PREVIEW_PROCESSING_TIMEOUT_MS,
} from "./ai-context"
export type { AwaitLinkPreviewProcessingResult, LinkPreviewContextMessage } from "./ai-context"
