// Metadata schemas come FIRST so that consumers reaching this barrel via a
// cycle (e.g. public-api/schemas.ts → messaging → event-service →
// public-api/...) find `messageMetadataSchema` already bound. With the
// heavy modules above, evaluating `event-service` could transitively load
// public-api/schemas.ts before `metadata-schema.ts` had a chance to run,
// producing a TDZ ("Cannot access 'messageMetadataSchema' before
// initialization") at integration-test boot.
export {
  messageMetadataSchema,
  messageMetadataFilterSchema,
  MESSAGE_METADATA_MAX_KEYS,
  MESSAGE_METADATA_MAX_KEY_LENGTH,
  MESSAGE_METADATA_MAX_VALUE_LENGTH,
  MESSAGE_METADATA_MAX_SERIALIZED_BYTES,
  MESSAGE_METADATA_RESERVED_PREFIX,
} from "./metadata-schema"

export { deriveContentMarkdown } from "./content"

export { MessageRepository } from "./repository"
export type { Message, InsertMessageParams } from "./repository"

export { MessageVersionRepository } from "./version-repository"
export type { MessageVersion } from "./version-repository"

export { EventService } from "./event-service"
export type { ConversationAssigner } from "./event-service"
export type {
  MessageCreatedPayload,
  MessageEditedPayload,
  MessageDeletedPayload,
  ReactionPayload,
  ThreadCreatedPayload,
  CreateMessageParams,
  EditMessageParams,
  DeleteMessageParams,
  AddReactionParams,
  RemoveReactionParams,
  MoveMessagesToThreadParams,
  ValidateMoveMessagesToThreadParams,
  MoveMessagesToThreadResult,
} from "./event-service"

export { createMessageHandlers } from "./handlers"
export {
  createMessageSchema,
  updateMessageSchema,
  addReactionSchema,
  moveMessagesToThreadSchema,
  validateMoveMessagesToThreadSchema,
} from "./handlers"

export {
  ShareService,
  SharedMessageRepository,
  collectShareReferences,
  crossesPrivacyBoundary,
  invalidatePointersForEvent,
  hydrateSharedMessages,
  hydrateSharedMessageIds,
  collectSharedMessageIds,
  POINTER_INVALIDATED_EVENT,
  type SharedMessage,
  type InsertSharedMessageParams,
  type PrivacyBoundaryResult,
  type ValidateAndRecordSharesParams,
  type HydratedSharedMessage,
} from "./sharing"
