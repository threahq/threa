export { DocRepository } from "./repository"
export { projectDoc } from "./projection"
export { loadDocState, ydocToContentJson, writeContentJson, encodeUpdateBase64, decodeUpdateBase64 } from "./yjs"
export { DocService, DOC_SNAPSHOT_INTERVAL } from "./service"
export { createDocHandlers } from "./handlers"
export {
  DOC_ACTIVITY_QUIET_MS,
  DOC_AWARENESS_RATE_BURST,
  DOC_AWARENESS_RATE_REFILL_PER_SEC,
  DOC_PUBLIC_MARKDOWN_MAX_CHARS,
  DOC_REASON_MAX_CHARS,
} from "./config"
export { DocActivityService } from "./activity-service"
export { DocActivityOutboxHandler } from "./activity-outbox-handler"
export { createDocActivityWorker } from "./activity-worker"
export { DocAgentService, type DocAgentContext, type DocAgentTurn, type HostedDocAgentContext } from "./agent-service"
export { docHostFor, listHostedDocs, docFirstLine, UNTITLED_DOC_LABEL, type HostedDoc } from "./hosted-docs"
export type { DocAgentEdit } from "./agent-markdown"
export type {
  DocAgentAccessRefusal,
  DocAgentCreateResult,
  DocAgentDocSummary,
  DocAgentEditRefusal,
  DocAgentListResult,
  DocAgentReadResult,
  DocAgentRefusalCode,
  DocAgentRewriteFailure,
  DocAgentTitleResult,
  DocAgentWriteResult,
} from "./agent-types"
