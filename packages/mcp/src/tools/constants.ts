// Mirrors @threa/types constants; inlined because @threa/mcp stays dependency-light
// against the version-pinned public API.
export const STREAM_TYPES = ["scratchpad", "channel", "dm", "thread", "system"] as const
export const CONVERSATION_STATUSES = ["active", "stalled", "resolved"] as const
