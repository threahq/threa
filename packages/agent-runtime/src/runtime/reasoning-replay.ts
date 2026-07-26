import type { ModelMessage } from "ai"

type ProviderOptions = Record<string, Record<string, unknown>>

type ContentPart = { type: string; providerOptions?: ProviderOptions }

function reasoningDetailsOf(part: ContentPart): unknown {
  return part.providerOptions?.openrouter?.reasoning_details
}

function carriesDetails(part: ContentPart): boolean {
  const details = reasoningDetailsOf(part)
  return Array.isArray(details) && details.length > 0
}

export function sanitizeAssistantReplay(message: ModelMessage): ModelMessage {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return message

  const parts = message.content as ContentPart[]
  const reasoningCarriesDetails = parts.some((part) => part.type === "reasoning" && carriesDetails(part))
  if (!reasoningCarriesDetails) return message

  let changed = false
  const content = parts.map((part) => {
    if (part.type !== "tool-call" || !part.providerOptions?.openrouter) return part
    if (!("reasoning_details" in part.providerOptions.openrouter)) return part

    const { reasoning_details: _dropped, ...openrouter } = part.providerOptions.openrouter
    changed = true
    return { ...part, providerOptions: { ...part.providerOptions, openrouter } }
  })

  if (!changed) return message
  return { ...message, content } as ModelMessage
}
