export {
  ShareService,
  collectShareReferences,
  privacyConfirmationRequired,
  type ValidateAndRecordSharesParams,
} from "./service"
export {
  SharedMessageRepository,
  UnsharedReferenceRepository,
  type SharedMessage,
  type InsertSharedMessageParams,
  type UnsharedReference,
} from "./repository"
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
