// Mirrors @threahq/types constants; inlined because @threahq/cli stays dependency-light
// against the version-pinned public API.
export const CALLBACK_TOKEN_HEADER = "X-Threa-Callback-Token"
export const STREAM_TYPES = ["scratchpad", "channel", "dm", "thread", "system", "aside"] as const
export const CONVERSATION_STATUSES = ["active", "stalled", "resolved"] as const
export const MEMO_TYPES = ["message", "conversation"] as const
export const KNOWLEDGE_TYPES = ["decision", "learning", "procedure", "context", "reference"] as const
export const MEMO_SCOPES = ["user", "stream", "workspace"] as const
export const EXTRACTION_CONTENT_TYPES = [
  "chart",
  "table",
  "diagram",
  "screenshot",
  "photo",
  "document",
  "other",
] as const
