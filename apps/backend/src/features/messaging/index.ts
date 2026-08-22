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
  MESSAGE_METADATA_AGENT_BLOCK_AUTHORS_KEY,
  withDerivedMessageMetadata,
} from "./metadata-schema"

export { deriveContentMarkdown } from "./content"

export { MessageRepository, REPLY_COUNT_SUBQUERY } from "./repository"
export type { Message, InsertMessageParams } from "./repository"

export { MessageVersionRepository, messageVersionKey } from "./version-repository"
export type { MessageVersion, MessageVersionKey } from "./version-repository"

export { resolveMessageReferences, sliceReferenceContent } from "./references"
export { registerMessageReferencePinsBackfill, MESSAGE_REFERENCE_PINS_BACKFILL_NAME } from "./references"
export type { ResolveMessageReferencesResult, ReferenceContent } from "./references"

export { EventService } from "./event-service"
export type { ConversationAssigner, GetComposeTraceMode } from "./event-service"
export { MessageComposeTraceRepository } from "./compose-trace-repository"
export type { MessageComposeTrace } from "./compose-trace-repository"
export type {
  MessageCreatedPayload,
  MessageEditedPayload,
  MessageDeletedPayload,
  ReactionPayload,
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
export { SteeredMessageService } from "./steered-message-service"
export {
  createMessageSchema,
  updateMessageSchema,
  addReactionSchema,
  moveMessagesToThreadSchema,
  validateMoveMessagesToThreadSchema,
  conversationDirectiveSchema,
} from "./handlers"

export {
  ShareService,
  SharedMessageRepository,
  collectShareReferences,
  crossesPrivacyBoundary,
  invalidatePointersForEvent,
  hydrateSharedMessages,
  hydrateSharedMessageRefs,
  hydrateSharedMessageRefsForAccessibleSet,
  collectSharedMessageIds,
  collectSharedMessageRefs,
  toDualSlotMaps,
  POINTER_INVALIDATED_EVENT,
  type SharedMessage,
  type InsertSharedMessageParams,
  type PrivacyBoundaryResult,
  type ValidateAndRecordSharesParams,
  type HydratedSharedMessage,
  type DualSlotMaps,
} from "./sharing"
