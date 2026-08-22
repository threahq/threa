export { ShareService, collectShareReferences, type ValidateAndRecordSharesParams } from "./service"
export { SharedMessageRepository, type SharedMessage, type InsertSharedMessageParams } from "./repository"
export {
  crossesPrivacyBoundary,
  type PrivacyBoundaryResult,
  type SharingStream,
  type FindStreamForSharing,
  type IsAncestorStream,
  type CountExposedMembers,
  type CanReadStream,
  type ResolveEffectiveStream,
} from "./access-check"
export { invalidatePointersForEvent, POINTER_INVALIDATED_EVENT } from "./outbox-handler"
export {
  hydrateSharedMessages,
  hydrateSharedMessageRefs,
  hydrateSharedMessageRefsForRoom,
  hydrateSharedMessageRefsForAccessibleSet,
  collectSharedMessageIds,
  collectSharedMessageRefs,
  toDualSlotMaps,
  type HydratedSharedMessage,
  type DualSlotMaps,
} from "./hydration"
