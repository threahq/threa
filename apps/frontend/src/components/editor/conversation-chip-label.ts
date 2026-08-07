interface ConversationChipLabelInput {
  accessTier: "full" | "private" | "cross_workspace" | null | undefined
  resolvedName: string | null
  isE2e: boolean
  pending: boolean
}

export function conversationChipLabel(input: ConversationChipLabelInput): string {
  if (input.accessTier === "cross_workspace") return "Another workspace"
  if (input.accessTier === "private") return "Private conversation"
  if (input.resolvedName) return input.resolvedName
  if (input.accessTier === "full" && input.isE2e) {
    return input.pending ? "Loading encrypted conversation" : "Encrypted conversation"
  }
  return "Conversation"
}
