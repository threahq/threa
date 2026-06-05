import type { RawChatFn } from "../llm"

/** Hard cap on a generated title's length (characters), matching a sensible UI width. */
const MAX_TITLE_CHARS = 60
/** Plenty for a handful of words; keeps the extra call cheap. */
const TITLE_MAX_TOKENS = 24

/**
 * Normalize a model-produced title into a single clean line, or null if there's
 * nothing usable. Strips surrounding quotes the model often adds, flattens to
 * the first line, collapses whitespace, and caps length. Language-agnostic — no
 * locale heuristics (INV-54); phrasing is the model's job.
 */
export function sanitizeTitle(raw: string | null | undefined): string | null {
  if (!raw) return null
  const firstLine = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!firstLine) return null
  // Drop matching surrounding quotes (straight or curly) and trailing period.
  const unquoted = firstLine
    .replace(/^["'“”‘’]+/, "")
    .replace(/["'“”‘’]+$/, "")
    .replace(/\.+$/, "")
    .replace(/\s+/g, " ")
    .trim()
  if (unquoted.length === 0) return null
  return unquoted.length > MAX_TITLE_CHARS ? unquoted.slice(0, MAX_TITLE_CHARS).trim() : unquoted
}

/**
 * Generate a short title for an encrypted scratchpad from its decrypted opening
 * turn. Runs inside the enclave (the only place this plaintext exists) as one
 * cheap completion over the same model the turn used. Best-effort: any failure
 * or empty result returns null and the caller simply skips titling — never
 * blocks or fails the turn.
 */
export async function generateTitle(params: {
  rawChat: RawChatFn
  model: string
  promptText: string
  replyText: string
}): Promise<string | null> {
  const conversation = `User:\n${params.promptText}\n\nAssistant:\n${params.replyText}`.slice(0, 4000)
  try {
    const result = await params.rawChat({
      model: params.model,
      maxTokens: TITLE_MAX_TOKENS,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You name a conversation. Reply with ONLY a short, specific title of 3 to 6 words — no quotes, no surrounding punctuation, no preamble. Use the same language as the conversation.",
        },
        { role: "user", content: conversation },
      ],
    })
    return sanitizeTitle(result.message.content)
  } catch {
    return null
  }
}
