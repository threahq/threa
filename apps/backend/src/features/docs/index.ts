export { DocRepository, type DocHead, type DocUpdate, type DocSnapshot } from "./repository"
export { projectDoc, diffSections, type DocSection, type DocProjection } from "./projection"
export {
  DOC_FRAGMENT,
  EMPTY_DOC_JSON,
  DocUpdateNotApplicableError,
  loadDocState,
  applyClientUpdate,
  encodeFullState,
  ydocToContentJson,
  contentJsonToYDoc,
  writeContentJson,
  encodeUpdateBase64,
  decodeUpdateBase64,
} from "./yjs"
export { DocService, DOC_SNAPSHOT_INTERVAL, type DocState, type DocUpdateView, type DocWriterType } from "./service"
export { createDocHandlers } from "./handlers"
