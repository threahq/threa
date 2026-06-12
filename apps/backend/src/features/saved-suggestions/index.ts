export { SavedSuggestionsService } from "./service"
export type { SavedItemCreator, CollectForConversationParams } from "./service"
export { SuggestionExtractor } from "./extractor"
export { SavedSuggestionsRepository } from "./repository"
export type { SavedSuggestion } from "./repository"
export { createSavedSuggestionsHandlers } from "./handlers"
export { toSuggestionView } from "./view"
export { SUGGESTION_EXTRACTOR_MODEL_ID, SUGGESTION_EXTRACTOR_TEMPERATURE, SUGGESTION_CONFIDENCE_FLOOR } from "./config"

/**
 * Optional collector slice the memo pipeline calls after classification.
 * Kept as an interface so MemoService depends on the capability, not the
 * concrete service (INV-52).
 */
export interface SuggestionCollectorLike {
  collectForConversation(params: import("./service").CollectForConversationParams): Promise<number>
}
