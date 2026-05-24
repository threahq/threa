import type { AI } from "../../lib/ai/ai"
import { logger } from "../../lib/logger"

export const POLISH_MODEL = "openrouter:openai/gpt-5.4-nano"
const POLISH_TIMEOUT_MS = 2500
const POLISH_CONTEXT_CHUNK_LIMIT = 6
const POLISH_CONTEXT_CHAR_LIMIT = 1200
const POLISH_MAX_TOKENS = 512

const SYSTEM_PROMPT = `You polish dictated speech for a chat composer. The user spoke a single chunk of text; the raw transcript may have run-on sentences, missing punctuation, and lowercase starts.

Rules:
- Preserve the speaker's words and intent. Never paraphrase, summarize, expand abbreviations, translate, or add information.
- Fix obvious transcription artifacts: capitalization at sentence start, terminal punctuation, comma splices, restored apostrophes, common homophone slips ("there"/"their") only when context makes it unambiguous.
- Add light markdown only when it is clearly the right shape: bullet items for an enumerated list the speaker dictated as a list, inline backticks only for words the speaker explicitly said as code (e.g. names of variables, function names, files). Do not invent headings, code blocks, links, or quotes.
- Emoji are allowed sparingly when they fit naturally at the end of a clause; never start a chunk with one and never replace words with them. If unsure, omit.
- The chunk continues from the prior context; do not greet, do not repeat prior text, do not add a leading newline.
- Output the polished new chunk only. No commentary, no quotes around the result, no prefixes like "Here:".
- If the raw text is already clean, return it unchanged.`

export interface PolishTranscriptChunkInput {
  raw: string
  priorPolishedChunks: readonly string[]
  workspaceId: string
  userId: string
  sessionId: string
}

export type PolishTranscriptChunk = (input: PolishTranscriptChunkInput) => Promise<string>

/**
 * Builds the polish entrypoint used by the voice relay. The returned function
 * never throws — on timeout or upstream error it logs and returns the raw text
 * so dictation always commits something. Each call sends the prior polished
 * chunks (capped) as context so the model can continue lists or threads
 * coherently without seeing or rewriting earlier text.
 */
export function createPolishTranscriptChunk(deps: { ai: AI }): PolishTranscriptChunk {
  return async ({ raw, priorPolishedChunks, workspaceId, userId, sessionId }) => {
    const trimmed = raw.trim()
    if (!trimmed) return raw

    const contextBlock = buildContextBlock(priorPolishedChunks)
    const userMessage = contextBlock
      ? `${contextBlock}\n\nNew chunk to polish (return only the polished version of this):\n${trimmed}`
      : `New chunk to polish (return only the polished version of this):\n${trimmed}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), POLISH_TIMEOUT_MS)

    try {
      const result = await deps.ai.generateText({
        model: POLISH_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        maxTokens: POLISH_MAX_TOKENS,
        temperature: 0.2,
        telemetry: {
          functionId: "voice-transcript-polish",
          metadata: {
            sessionId,
            rawLen: trimmed.length,
            priorChunkCount: priorPolishedChunks.length,
          },
        },
        context: { workspaceId, userId, origin: "user" },
        abortSignal: controller.signal,
      })

      const polished = result.value.trim()
      if (!polished) return raw
      return polished
    } catch (err) {
      logger.warn({ err, sessionId, workspaceId }, "Voice transcript polish failed; falling back to raw")
      return raw
    } finally {
      clearTimeout(timer)
    }
  }
}

function buildContextBlock(priorPolishedChunks: readonly string[]): string {
  if (priorPolishedChunks.length === 0) return ""
  // Most recent N chunks, then trim from the front if the joined text would
  // blow past the char budget — keeping the most recent context is what helps
  // list continuation and pronoun resolution.
  const recent = priorPolishedChunks.slice(-POLISH_CONTEXT_CHUNK_LIMIT)
  let joined = recent.join(" ")
  while (joined.length > POLISH_CONTEXT_CHAR_LIMIT && recent.length > 1) {
    recent.shift()
    joined = recent.join(" ")
  }
  if (joined.length > POLISH_CONTEXT_CHAR_LIMIT) {
    joined = joined.slice(joined.length - POLISH_CONTEXT_CHAR_LIMIT)
  }
  return `Prior context (already in the document, do not repeat or rewrite):\n${joined}`
}
